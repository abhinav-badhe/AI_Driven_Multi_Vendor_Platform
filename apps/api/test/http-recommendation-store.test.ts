import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryRecommendationStore,
  HttpRecommendationStoreAdapter,
  type DerivedRecommendationRecord,
} from '../src/modules/recommendations/index.js';
import { ExternalServiceError } from '../src/errors/app-error.js';

describe('Domain 17: Recommendations Decoupled Store & HTTP Adapter', () => {
  const sampleRec: DerivedRecommendationRecord = {
    id: 'rec-1',
    scopeKey: 'tenant-1:TRENDING:NONE:NONE:prod-101',
    tenantId: 'tenant-1',
    customerId: null,
    recommendationType: 'TRENDING',
    sourceProductId: null,
    recommendedProductId: 'prod-101',
    rankPosition: 1,
    score: 95.5,
    reasonCode: 'TRENDING',
    explanation: 'High velocity purchases across catalog',
    derivedMetadata: { unitsSold: 42 },
    createdAt: '2026-10-10T12:00:00Z',
    updatedAt: '2026-10-10T12:00:00Z',
  };

  const sampleRec2: DerivedRecommendationRecord = {
    id: 'rec-2',
    scopeKey: 'tenant-1:TRENDING:NONE:NONE:prod-102',
    tenantId: 'tenant-1',
    customerId: null,
    recommendationType: 'TRENDING',
    sourceProductId: null,
    recommendedProductId: 'prod-102',
    rankPosition: 2,
    score: 80.0,
    reasonCode: 'TRENDING',
    explanation: 'Second highest velocity purchases',
    derivedMetadata: { unitsSold: 28 },
    createdAt: '2026-10-10T12:00:00Z',
    updatedAt: '2026-10-10T12:00:00Z',
  };

  describe('InMemoryRecommendationStore', () => {
    it('saves and retrieves recommendations sorted by rankPosition', async () => {
      const store = new InMemoryRecommendationStore();
      await store.saveRecommendations([sampleRec2, sampleRec]);

      const items = await store.getRecommendations('tenant-1', 'TRENDING');
      expect(items).toHaveLength(2);
      expect(items[0]!.recommendedProductId).toBe('prod-101');
      expect(items[1]!.recommendedProductId).toBe('prod-102');
    });

    it('filters recommendations by customerId, sourceProductId, and limit', async () => {
      const store = new InMemoryRecommendationStore();
      const personalizedRec: DerivedRecommendationRecord = {
        ...sampleRec,
        id: 'rec-p1',
        scopeKey: 'tenant-1:PERSONALIZED:cust-1:NONE:prod-101',
        recommendationType: 'PERSONALIZED',
        customerId: 'cust-1',
      };
      await store.saveRecommendations([personalizedRec, sampleRec]);

      const cust1Recs = await store.getRecommendations('tenant-1', 'PERSONALIZED', {
        customerId: 'cust-1',
      });
      expect(cust1Recs).toHaveLength(1);
      expect(cust1Recs[0]!.id).toBe('rec-p1');

      const cust2Recs = await store.getRecommendations('tenant-1', 'PERSONALIZED', {
        customerId: 'cust-2',
      });
      expect(cust2Recs).toHaveLength(0);
    });

    it('filters out expired recommendations', async () => {
      const store = new InMemoryRecommendationStore();
      const expiredRec: DerivedRecommendationRecord = {
        ...sampleRec,
        id: 'rec-expired',
        scopeKey: 'tenant-1:TRENDING:NONE:NONE:prod-expired',
        expiresAt: '2020-01-01T00:00:00Z',
      };
      await store.saveRecommendations([expiredRec, sampleRec]);

      const items = await store.getRecommendations('tenant-1', 'TRENDING');
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe('rec-1');
    });

    it('deletes by scope and clears tenant recommendations', async () => {
      const store = new InMemoryRecommendationStore();
      await store.saveRecommendations([sampleRec, sampleRec2]);

      const deleted = await store.deleteByScope('tenant-1', 'TRENDING');
      expect(deleted).toBe(2);
      expect(await store.getRecommendations('tenant-1', 'TRENDING')).toHaveLength(0);
    });

    it('invalidates recommendations when a product is archived or removed', async () => {
      const store = new InMemoryRecommendationStore();
      await store.saveRecommendations([sampleRec, sampleRec2]);

      const invalidated = await store.invalidateProduct('tenant-1', 'prod-101');
      expect(invalidated).toBe(1);

      const remaining = await store.getRecommendations('tenant-1', 'TRENDING');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.recommendedProductId).toBe('prod-102');
    });

    it('records and returns rebuild audits', async () => {
      const store = new InMemoryRecommendationStore();
      await store.recordRebuildAudit({
        id: 'audit-1',
        tenantId: 'tenant-1',
        rebuiltByActorId: 'admin-1',
        recommendationsGenerated: 10,
        startedAt: '2026-10-10T00:00:00.000Z',
        completedAt: '2026-10-10T00:00:01.000Z',
        status: 'COMPLETED',
      });

      const audits = store.getAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.id).toBe('audit-1');
      expect(audits[0]!.recommendationsGenerated).toBe(10);
    });
  });

  describe('HttpRecommendationStoreAdapter', () => {
    it('delegates saveRecommendations via POST /v1/recommendations/store/save', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ saved: 1 }),
      });

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await store.saveRecommendations([sampleRec]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://recommendations-service:4060/v1/recommendations/store/save',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ records: [sampleRec] }),
        }),
      );
    });

    it('delegates getRecommendations via POST /v1/recommendations/store/query', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ records: [sampleRec] }),
      });

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const results = await store.getRecommendations('tenant-1', 'TRENDING', { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('rec-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://recommendations-service:4060/v1/recommendations/store/query',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            tenantId: 'tenant-1',
            type: 'TRENDING',
            customerId: null,
            sourceProductId: null,
            limit: 5,
          }),
        }),
      );
    });

    it('delegates deleteByScope, clearTenant, and invalidateProduct', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ deletedCount: 2 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ deletedCount: 5 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ deletedCount: 1 }),
        });

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await store.deleteByScope('tenant-1', 'TRENDING')).toBe(2);
      expect(await store.clearTenantRecommendations('tenant-1')).toBe(5);
      expect(await store.invalidateProduct('tenant-1', 'prod-101')).toBe(1);
    });

    it('delegates recordRebuildAudit via POST /v1/recommendations/store/audit', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'recorded' }),
      });

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await store.recordRebuildAudit({
        id: 'audit-1',
        tenantId: 'tenant-1',
        rebuiltByActorId: 'admin-1',
        recommendationsGenerated: 2,
        startedAt: '2026-10-10T00:00:00.000Z',
        completedAt: '2026-10-10T00:00:01.000Z',
        status: 'COMPLETED',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://recommendations-service:4060/v1/recommendations/store/audit',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('resiliently falls back to local in-memory store when remote HTTP call fails', async () => {
      const fallbackStore = new InMemoryRecommendationStore();
      await fallbackStore.saveRecommendations([sampleRec]);

      const failingFetch = vi.fn().mockRejectedValue(new Error('Network ECONNREFUSED'));

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: failingFetch as unknown as typeof fetch,
        fallbackStore,
      });

      // Fails on remote, transparently executes against fallbackStore
      const results = await store.getRecommendations('tenant-1', 'TRENDING');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('rec-1');
    });

    it('throws ExternalServiceError when remote fails and no fallback is configured', async () => {
      const failingFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const store = new HttpRecommendationStoreAdapter('http://recommendations-service:4060', {
        fetchFn: failingFetch as unknown as typeof fetch,
      });

      await expect(store.getRecommendations('tenant-1', 'TRENDING')).rejects.toThrowError(
        ExternalServiceError,
      );
    });
  });
});
