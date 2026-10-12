import { describe, it, expect, vi } from 'vitest';
import {
  HttpSettlementClient,
  InMemorySettlementStore,
  type FinancialSummaryDto,
  type LedgerEntryDto,
  type SettlementDto,
  type FinancialAdjustmentDto,
} from '../src/modules/settlement-ledger/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  InvalidStateTransitionError,
} from '../src/errors/app-error.js';

const mockAdminActor: AuthorizedActor = {
  userId: 'usr-admin-1',
  tenantId: 'tenant-admin-1',
  role: 'ADMINISTRATOR',
};

const mockMerchantActor: AuthorizedActor = {
  userId: 'usr-merchant-1',
  tenantId: 'tenant-merchant-1',
  role: 'MERCHANT',
};

const mockSummary: FinancialSummaryDto = {
  tenantId: 'tenant-merchant-1',
  currency: 'INR',
  currentBalance: 900,
  pendingBalance: 0,
  settledBalance: 0,
  totalEarnings: 1000,
  totalCommissions: 100,
  totalFees: 0,
  totalRefunds: 0,
  totalAdjustments: 0,
  ledgerCount: 2,
};

const mockLedgerEntry: LedgerEntryDto = {
  id: 'led-123',
  financialTransactionId: 'tx-123',
  tenantId: 'tenant-merchant-1',
  accountId: 'acc-123',
  entryType: 'EARNING',
  direction: 'CREDIT',
  amount: 1000,
  currency: 'INR',
  sourceType: 'ORDER',
  sourceId: 'so-123',
  description: 'Gross merchandise earning for seller order so-123',
  reason: null,
  actorId: 'usr-admin-1',
  actorType: 'ADMINISTRATOR',
  idempotencyKey: 'idem-led-1',
  metadata: {},
  createdAt: new Date().toISOString(),
};

const mockAdjustment: FinancialAdjustmentDto = {
  id: 'adj-123',
  tenantId: 'tenant-merchant-1',
  amount: 50,
  currency: 'INR',
  type: 'CREDIT',
  reason: 'Promotion credit subsidy',
  status: 'APPROVED',
  actorId: 'usr-admin-1',
  actorType: 'ADMINISTRATOR',
  idempotencyKey: 'idem-adj-1',
  createdAt: new Date().toISOString(),
};

const mockSettlement: SettlementDto = {
  id: 'stl-123',
  tenantId: 'tenant-merchant-1',
  periodStart: new Date(Date.now() - 86400000 * 7).toISOString(),
  periodEnd: new Date().toISOString(),
  currency: 'INR',
  grossAmount: 1000,
  commissionAmount: 100,
  feeAmount: 0,
  refundAmount: 0,
  adjustmentAmount: 0,
  netPayableAmount: 900,
  status: 'CALCULATED',
  idempotencyKey: 'idem-stl-1',
  snapshotData: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [],
};

describe('HttpSettlementClient', () => {
  it('delegates getFinancialSummary over HTTP with headers and query', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockSummary), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpSettlementClient('http://settlement-service:4150', { fetchFn });
    const result = await client.getFinancialSummary(mockMerchantActor, 'tenant-merchant-1', 'INR');

    expect(result).toEqual(mockSummary);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://settlement-service:4150/settlement/merchants/tenant-merchant-1/summary?currency=INR',
    );
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'x-user-id': 'usr-merchant-1',
        'x-tenant-id': 'tenant-merchant-1',
        'x-user-role': 'MERCHANT',
      }),
    );
  });

  it('delegates listLedgerEntries over HTTP with filter query parameters', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ entries: [mockLedgerEntry] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpSettlementClient('http://settlement-service:4150', { fetchFn });
    const entries = await client.listLedgerEntries(mockMerchantActor, 'tenant-merchant-1', {
      entryType: 'EARNING',
      limit: 10,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('led-123');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/settlement/merchants/tenant-merchant-1/ledger?');
    expect(url).toContain('entryType=EARNING');
    expect(url).toContain('limit=10');
    expect(init.method).toBe('GET');
  });

  it('delegates ingestOrderFinancials and ingestRefundFinancials over HTTP', async () => {
    const orderResult = {
      earningEntry: mockLedgerEntry,
      commissionEntry: {
        ...mockLedgerEntry,
        id: 'led-124',
        entryType: 'COMMISSION' as const,
        amount: 100,
      },
    };

    const refundResult = {
      refundEntry: { ...mockLedgerEntry, id: 'led-125', entryType: 'REFUND' as const, amount: 200 },
    };

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/order')) {
        return Promise.resolve(
          new Response(JSON.stringify(orderResult), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(refundResult), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new HttpSettlementClient('http://settlement-service:4150', { fetchFn });

    const orderRes = await client.ingestOrderFinancials(mockAdminActor, {
      sellerOrderId: 'so-123',
      commissionRate: 0.1,
    });
    expect(orderRes.earningEntry.id).toBe('led-123');

    const refundRes = await client.ingestRefundFinancials(mockAdminActor, {
      merchantId: 'tenant-merchant-1',
      refundId: 'ref-123',
      refundAmount: 200,
      currency: 'INR',
    });
    expect(refundRes.refundEntry.id).toBe('led-125');
  });

  it('delegates createAdjustment, calculateSettlement, getSettlement, and transitionSettlementStatus over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/adjustments')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ adjustment: mockAdjustment, ledgerEntry: mockLedgerEntry }),
            {
              status: 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/calculate')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockSettlement), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/transition')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ...mockSettlement, status: 'APPROVED' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockSettlement), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new HttpSettlementClient('http://settlement-service:4150', { fetchFn });

    const result = await client.createAdjustment(mockAdminActor, {
      merchantId: 'tenant-merchant-1',
      amount: 50,
      currency: 'INR',
      type: 'CREDIT',
      reason: 'Promotion credit subsidy',
    });
    expect(result.adjustment.id).toBe('adj-123');
    expect(result.ledgerEntry.id).toBe('led-123');

    const calcResult = await client.calculateSettlement(mockAdminActor, {
      merchantId: 'tenant-merchant-1',
      periodStart: new Date(Date.now() - 86400000 * 7).toISOString(),
      periodEnd: new Date().toISOString(),
      currency: 'INR',
    });
    expect(calcResult.id).toBe('stl-123');

    const fetchedSettlement = await client.getSettlement(mockMerchantActor, 'stl-123');
    expect(fetchedSettlement.id).toBe('stl-123');

    const transitioned = await client.transitionSettlementStatus(mockAdminActor, 'stl-123', {
      targetStatus: 'APPROVED',
    });
    expect(transitioned.status).toBe('APPROVED');
  });

  it('maps error codes correctly from HTTP response', async () => {
    const validationFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid journal' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    const client = new HttpSettlementClient('http://settlement-service:4150', {
      fetchFn: validationFetch,
    });
    await expect(
      client.ingestOrderFinancials(mockAdminActor, { sellerOrderId: '' }),
    ).rejects.toThrowError(ValidationError);

    const notFoundFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Settlement not found' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    const notFoundClient = new HttpSettlementClient('http://settlement-service:4150', {
      fetchFn: notFoundFetch,
    });
    await expect(
      notFoundClient.getSettlement(mockMerchantActor, 'stl-missing'),
    ).rejects.toThrowError(NotFoundError);

    const transitionFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: 'Cannot transition settled settlement',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transitionClient = new HttpSettlementClient('http://settlement-service:4150', {
      fetchFn: transitionFetch,
    });
    await expect(
      transitionClient.transitionSettlementStatus(mockAdminActor, 'stl-123', {
        targetStatus: 'CALCULATED',
      }),
    ).rejects.toThrowError(InvalidStateTransitionError);
  });

  it('resiliently falls back to local/in-memory store on connection failure', async () => {
    const memoryStore = new InMemorySettlementStore();
    memoryStore.seedLedgerEntry(mockLedgerEntry);
    memoryStore.seedSettlement(mockSettlement);

    const failingFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED connect to settlement-service:4150')),
      );

    const client = new HttpSettlementClient('http://settlement-service:4150', {
      fetchFn: failingFetch,
      fallbackService: memoryStore,
    });

    const summary = await client.getFinancialSummary(mockMerchantActor, 'tenant-merchant-1', 'INR');
    expect(summary.tenantId).toBe('tenant-merchant-1');
    expect(summary.totalEarnings).toBe(1000);

    const settlement = await client.getSettlement(mockMerchantActor, 'stl-123');
    expect(settlement.id).toBe('stl-123');
  });
});
