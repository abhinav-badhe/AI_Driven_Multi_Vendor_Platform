import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryAnalyticsReader,
  HttpAnalyticsClient,
  type TrendingProductSignal,
  type CustomerPurchaseHistorySignal,
  type CoPurchaseSignal,
  type ProductDailyDemandRecord,
  type InventoryVelocitySignal,
  type CustomerActivitySignal,
  type OrderAnomalySignal,
} from '../src/modules/analytics/index.js';
import { ExternalServiceError } from '../src/errors/app-error.js';

describe('Domain 15: Analytics Decoupled Readers & HTTP Client', () => {
  const sampleTrending: TrendingProductSignal = {
    productId: 'prod-101',
    unitsSold: 50,
    orderCount: 30,
  };

  const samplePurchaseHistory: CustomerPurchaseHistorySignal = {
    productId: 'prod-101',
    purchaseCount: 3,
  };

  const sampleCoPurchase: CoPurchaseSignal = {
    productId: 'prod-102',
    coPurchaseCount: 15,
  };

  const sampleDemandRecord: ProductDailyDemandRecord = {
    tenantId: 'tenant-1',
    productId: 'prod-101',
    sku: 'SKU-101',
    date: '2026-10-10',
    unitsSold: 5,
    orderCount: 4,
    price: 49.99,
  };

  const sampleVelocitySignal: InventoryVelocitySignal = {
    tenantId: 'tenant-1',
    productId: 'prod-101',
    sku: 'SKU-101',
    currentOnHand: 100,
    reservedQuantity: 10,
    velocity7d: 15,
    velocity14d: 28,
    leadTimeDays: 7,
  };

  const sampleActivitySignal: CustomerActivitySignal = {
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    recencyDays: 2,
    frequency30d: 4,
    frequency90d: 8,
    totalOrders: 12,
    monetaryTotal: 599.99,
  };

  const sampleAnomalySignal: OrderAnomalySignal = {
    tenantId: 'tenant-1',
    orderId: 'order-999',
    totalAmount: 1500.0,
    lineCount: 1,
    totalQuantity: 200,
    hourOfDay: 3,
    dayOfWeek: 2,
  };

  describe('InMemoryAnalyticsReader', () => {
    it('stores and retrieves trending products with limit and tenant scoping', async () => {
      const reader = new InMemoryAnalyticsReader();
      reader.setTrendingProducts('tenant-1', [
        sampleTrending,
        { productId: 'prod-102', unitsSold: 40, orderCount: 20 },
      ]);

      const all = await reader.getTrendingProducts('tenant-1');
      expect(all).toHaveLength(2);

      const limited = await reader.getTrendingProducts('tenant-1', 1);
      expect(limited).toHaveLength(1);
      expect(limited[0]!.productId).toBe('prod-101');

      const otherTenant = await reader.getTrendingProducts('tenant-2');
      expect(otherTenant).toHaveLength(0);
    });

    it('stores and retrieves customer purchase history and co-purchases', async () => {
      const reader = new InMemoryAnalyticsReader();
      reader.setCustomerPurchaseHistory('tenant-1', 'cust-1', [samplePurchaseHistory]);
      reader.setCoPurchasedProducts('tenant-1', 'prod-101', [sampleCoPurchase]);

      const history = await reader.getCustomerPurchaseHistory('tenant-1', 'cust-1');
      expect(history).toHaveLength(1);
      expect(history[0]!.productId).toBe('prod-101');

      const coPurchases = await reader.getCoPurchasedProducts('tenant-1', 'prod-101');
      expect(coPurchases).toHaveLength(1);
      expect(coPurchases[0]!.productId).toBe('prod-102');
    });

    it('stores and retrieves ML feature signals (demand, velocity, customer, anomaly)', async () => {
      const reader = new InMemoryAnalyticsReader();
      reader.setProductDailyDemandHistory('tenant-1', [sampleDemandRecord]);
      reader.setInventoryVelocitySignals('tenant-1', [sampleVelocitySignal]);
      reader.setCustomerActivitySignals('tenant-1', [sampleActivitySignal]);
      reader.setOrderAnomalySignals('tenant-1', [sampleAnomalySignal]);

      expect(await reader.getProductDailyDemandHistory('tenant-1')).toHaveLength(1);
      expect(await reader.getInventoryVelocitySignals('tenant-1')).toHaveLength(1);
      expect(await reader.getCustomerActivitySignals('tenant-1')).toHaveLength(1);
      expect(await reader.getOrderAnomalySignals('tenant-1')).toHaveLength(1);
    });

    it('clears all in-memory analytical signals', async () => {
      const reader = new InMemoryAnalyticsReader();
      reader.setTrendingProducts('tenant-1', [sampleTrending]);
      reader.clear();
      expect(await reader.getTrendingProducts('tenant-1')).toHaveLength(0);
    });
  });

  describe('HttpAnalyticsClient', () => {
    it('delegates getTrendingProducts to GET /v1/analytics/signals/trending', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [sampleTrending] }),
      });

      const client = new HttpAnalyticsClient('http://analytics-service:4070', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await client.getTrendingProducts('tenant-1', 5);
      expect(res).toHaveLength(1);
      expect(res[0]!.productId).toBe('prod-101');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://analytics-service:4070/v1/analytics/signals/trending?tenantId=tenant-1&limit=5',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('delegates getCustomerPurchaseHistory and getCoPurchasedProducts', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [samplePurchaseHistory] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [sampleCoPurchase] }),
        });

      const client = new HttpAnalyticsClient('http://analytics-service:4070', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const history = await client.getCustomerPurchaseHistory('tenant-1', 'cust-1');
      expect(history).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://analytics-service:4070/v1/analytics/signals/customer-history?tenantId=tenant-1&customerId=cust-1',
        expect.anything(),
      );

      const coPurchases = await client.getCoPurchasedProducts('tenant-1', 'prod-101', 3);
      expect(coPurchases).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://analytics-service:4070/v1/analytics/signals/co-purchased?tenantId=tenant-1&sourceProductId=prod-101&limit=3',
        expect.anything(),
      );
    });

    it('delegates ML feature reader methods over HTTP', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [sampleDemandRecord] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [sampleVelocitySignal] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [sampleActivitySignal] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [sampleAnomalySignal] }),
        });

      const client = new HttpAnalyticsClient('http://analytics-service:4070', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const demand = await client.getProductDailyDemandHistory('tenant-1', 14);
      expect(demand).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://analytics-service:4070/v1/analytics/signals/ml/demand-history?tenantId=tenant-1&lookbackDays=14',
        expect.anything(),
      );

      const velocity = await client.getInventoryVelocitySignals('tenant-1');
      expect(velocity).toHaveLength(1);

      const activity = await client.getCustomerActivitySignals('tenant-1');
      expect(activity).toHaveLength(1);

      const anomaly = await client.getOrderAnomalySignals('tenant-1');
      expect(anomaly).toHaveLength(1);
    });

    it('resiliently falls back to InMemoryAnalyticsReader when remote HTTP call fails', async () => {
      const fallbackReader = new InMemoryAnalyticsReader();
      fallbackReader.setTrendingProducts('tenant-1', [sampleTrending]);

      const failingFetch = vi.fn().mockRejectedValue(new Error('Network ECONNREFUSED'));

      const client = new HttpAnalyticsClient('http://analytics-service:4070', {
        fetchFn: failingFetch as unknown as typeof fetch,
        fallbackReader,
      });

      const res = await client.getTrendingProducts('tenant-1');
      expect(res).toHaveLength(1);
      expect(res[0]!.productId).toBe('prod-101');
    });

    it('throws ExternalServiceError when remote fails and no fallback reader is configured', async () => {
      const failingFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const client = new HttpAnalyticsClient('http://analytics-service:4070', {
        fetchFn: failingFetch as unknown as typeof fetch,
      });

      await expect(client.getTrendingProducts('tenant-1')).rejects.toThrowError(
        ExternalServiceError,
      );
    });
  });
});
