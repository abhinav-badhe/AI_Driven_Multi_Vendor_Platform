import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type {
  SettlementService,
  SettlementStatus,
  LedgerEntryType,
  FinancialAdjustmentType,
} from '../modules/settlement-ledger/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import {
  CachePresets,
  CacheTags,
  cacheKey,
  sendCached,
} from './cache-helper.js';

export function registerSettlementRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  settlementService: SettlementService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. GET /settlement/merchants/:merchantId/summary
  app.get(
    '/settlement/merchants/:merchantId/summary',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { merchantId: string };
      const query = request.query as { currency?: string };

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('settlement', 'summary', params.merchantId, query.currency ?? 'INR'),
          tags: [CacheTags.settlement, `${CacheTags.settlement}:merchant:${params.merchantId}`],
          preset: CachePresets.merchantScoped,
        },
        () => settlementService.getFinancialSummary(actor, params.merchantId, query.currency ?? 'INR'),
      );
    },
  );

  // 2. GET /settlement/merchants/:merchantId/ledger
  app.get(
    '/settlement/merchants/:merchantId/ledger',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { merchantId: string };
      const query = request.query as {
        entryType?: string;
        sourceType?: string;
        sourceId?: string;
        startDate?: string;
        endDate?: string;
        limit?: string;
        offset?: string;
      };

      const filterParts = [
        query.entryType ? `type=${query.entryType}` : '',
        query.sourceType ? `src=${query.sourceType}` : '',
        query.sourceId ? `srcId=${query.sourceId}` : '',
        query.startDate ? `from=${query.startDate}` : '',
        query.endDate ? `to=${query.endDate}` : '',
        query.limit ? `limit=${query.limit}` : '',
        query.offset ? `offset=${query.offset}` : '',
      ]
        .filter((p) => p.length > 0)
        .sort();

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('settlement', 'ledger', params.merchantId, ...filterParts),
          tags: [CacheTags.settlement, `${CacheTags.settlement}:merchant:${params.merchantId}`],
          preset: CachePresets.merchantScoped,
        },
        async () => ({
          entries: await settlementService.listLedgerEntries(actor, params.merchantId, {
            entryType: query.entryType as LedgerEntryType | undefined,
            sourceType: query.sourceType,
            sourceId: query.sourceId,
            startDate: query.startDate,
            endDate: query.endDate,
            limit: query.limit ? parseInt(query.limit, 10) : undefined,
            offset: query.offset ? parseInt(query.offset, 10) : undefined,
          }),
        }),
      );
    },
  );

  // 3. POST /settlement/ingest/order
  app.post(
    '/settlement/ingest/order',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        sellerOrderId?: unknown;
        commissionRate?: unknown;
        feeAmount?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (typeof body.sellerOrderId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'sellerOrderId is required',
          },
        });
      }

      const result = await settlementService.ingestOrderFinancials(actor, {
        sellerOrderId: body.sellerOrderId,
        commissionRate: typeof body.commissionRate === 'number' ? body.commissionRate : undefined,
        feeAmount: typeof body.feeAmount === 'number' ? body.feeAmount : undefined,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      await app.cache.invalidateTags(CacheTags.settlement);
      return reply.status(201).send(result);
    },
  );

  // 4. POST /settlement/ingest/refund
  app.post(
    '/settlement/ingest/refund',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        merchantId?: unknown;
        refundId?: unknown;
        sellerOrderId?: unknown;
        refundAmount?: unknown;
        commissionRefundAmount?: unknown;
        currency?: unknown;
        reason?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (
        typeof body.merchantId !== 'string' ||
        typeof body.refundId !== 'string' ||
        typeof body.refundAmount !== 'number' ||
        typeof body.currency !== 'string'
      ) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'merchantId, refundId, refundAmount, and currency are required',
          },
        });
      }

      const result = await settlementService.ingestRefundFinancials(actor, {
        merchantId: body.merchantId,
        refundId: body.refundId,
        sellerOrderId: typeof body.sellerOrderId === 'string' ? body.sellerOrderId : undefined,
        refundAmount: body.refundAmount,
        commissionRefundAmount:
          typeof body.commissionRefundAmount === 'number' ? body.commissionRefundAmount : undefined,
        currency: body.currency,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      await app.cache.invalidateTags(CacheTags.settlement);
      return reply.status(201).send(result);
    },
  );

  // 5. POST /settlement/adjustments
  app.post(
    '/settlement/adjustments',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        merchantId?: unknown;
        amount?: unknown;
        currency?: unknown;
        type?: unknown;
        reason?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (
        typeof body.merchantId !== 'string' ||
        typeof body.amount !== 'number' ||
        typeof body.currency !== 'string' ||
        (body.type !== 'CREDIT' && body.type !== 'DEBIT') ||
        typeof body.reason !== 'string'
      ) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'merchantId, amount, currency, type (CREDIT|DEBIT), and reason are required',
          },
        });
      }

      const result = await settlementService.createAdjustment(actor, {
        merchantId: body.merchantId,
        amount: body.amount,
        currency: body.currency,
        type: body.type as FinancialAdjustmentType,
        reason: body.reason,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      await app.cache.invalidateTags(CacheTags.settlement);
      return reply.status(201).send(result);
    },
  );

  // 6. POST /settlement/settlements/calculate
  app.post(
    '/settlement/settlements/calculate',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        merchantId?: unknown;
        periodStart?: unknown;
        periodEnd?: unknown;
        currency?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (
        typeof body.merchantId !== 'string' ||
        typeof body.periodStart !== 'string' ||
        typeof body.periodEnd !== 'string' ||
        typeof body.currency !== 'string'
      ) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'merchantId, periodStart, periodEnd, and currency are required',
          },
        });
      }

      const settlement = await settlementService.calculateSettlement(actor, {
        merchantId: body.merchantId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        currency: body.currency,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      await app.cache.invalidateTags(CacheTags.settlement);
      return reply.status(201).send(settlement);
    },
  );

  // 7. GET /settlement/settlements/:settlementId
  app.get(
    '/settlement/settlements/:settlementId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { settlementId: string };

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('settlement', 'settlements', params.settlementId, actor.tenantId),
          tags: [CacheTags.settlement, `${CacheTags.settlement}:id:${params.settlementId}`],
          preset: CachePresets.merchantScoped,
        },
        () => settlementService.getSettlement(actor, params.settlementId),
      );
    },
  );

  // 8. POST /settlement/settlements/:settlementId/transition
  app.post(
    '/settlement/settlements/:settlementId/transition',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { settlementId: string };
      const body = (request.body as {
        targetStatus?: unknown;
        reason?: unknown;
        failureReason?: unknown;
      } | undefined) ?? {};

      if (typeof body.targetStatus !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'targetStatus is required',
          },
        });
      }

      const settlement = await settlementService.transitionSettlementStatus(
        actor,
        params.settlementId,
        {
          targetStatus: body.targetStatus as SettlementStatus,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          failureReason: typeof body.failureReason === 'string' ? body.failureReason : undefined,
        },
      );

      await app.cache.invalidateTags(
        CacheTags.settlement,
        `${CacheTags.settlement}:id:${params.settlementId}`,
      );
      return reply.status(200).send(settlement);
    },
  );
}
