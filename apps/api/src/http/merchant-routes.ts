import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { MerchantService } from '../modules/merchant/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';
import {
  CachePresets,
  CacheTags,
  cacheKey,
  sendCached,
} from './cache-helper.js';

export function registerMerchantRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  merchantService: MerchantService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // POST /merchants/onboard
  app.post(
    '/merchants/onboard',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = request.body as {
        businessName?: unknown;
        legalName?: unknown;
        contactEmail?: unknown;
      };

      if (typeof body.businessName !== 'string') throw new ValidationError('businessName is required');
      if (typeof body.legalName !== 'string') throw new ValidationError('legalName is required');
      if (typeof body.contactEmail !== 'string') throw new ValidationError('contactEmail is required');

      const profile = await merchantService.onboard(actor, {
        businessName: body.businessName,
        legalName: body.legalName,
        contactEmail: body.contactEmail,
      });

      await app.cache.invalidateTags(
        CacheTags.merchant,
        `${CacheTags.merchant}:tenant:${actor.tenantId}`,
      );
      return reply.status(201).send(profile);
    },
  );

  // GET /merchants/me
  app.get(
    '/merchants/me',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('merchants', 'me', actor.tenantId),
          tags: [CacheTags.merchant, `${CacheTags.merchant}:tenant:${actor.tenantId}`],
          preset: CachePresets.merchantScoped,
        },
        () => merchantService.getProfile(actor),
      );
    },
  );

  // PATCH /merchants/me
  app.patch(
    '/merchants/me',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = request.body as Record<string, unknown>;

      const profile = await merchantService.updateProfile(actor, {
        businessName: typeof body.businessName === 'string' ? body.businessName : undefined,
        legalName: typeof body.legalName === 'string' ? body.legalName : undefined,
        contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail : undefined,
      });

      await app.cache.invalidateTags(
        CacheTags.merchant,
        `${CacheTags.merchant}:tenant:${actor.tenantId}`,
      );
      return reply.status(200).send(profile);
    },
  );

  // POST /merchants/me/submit
  app.post(
    '/merchants/me/submit',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const profile = await merchantService.submitForVerification(actor);
      await app.cache.invalidateTags(
        CacheTags.merchant,
        `${CacheTags.merchant}:tenant:${actor.tenantId}`,
      );
      return reply.status(200).send(profile);
    },
  );

  // POST /merchants/:tenantId/approve (admin only)
  app.post(
    '/merchants/:tenantId/approve',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { tenantId } = request.params as { tenantId: string };
      const profile = await merchantService.approveMerchant(actor, tenantId);
      await app.cache.invalidateTags(
        CacheTags.merchant,
        `${CacheTags.merchant}:tenant:${tenantId}`,
      );
      return reply.status(200).send(profile);
    },
  );

  // POST /merchants/:tenantId/reject (admin only)
  app.post(
    '/merchants/:tenantId/reject',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { tenantId } = request.params as { tenantId: string };
      const body = request.body as { reason?: unknown };
      if (typeof body.reason !== 'string') throw new ValidationError('reason is required');

      const profile = await merchantService.rejectMerchant(actor, tenantId, body.reason);
      await app.cache.invalidateTags(
        CacheTags.merchant,
        `${CacheTags.merchant}:tenant:${tenantId}`,
      );
      return reply.status(200).send(profile);
    },
  );
}
