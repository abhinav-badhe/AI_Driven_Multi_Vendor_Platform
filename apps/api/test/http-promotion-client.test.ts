import { describe, it, expect, vi } from 'vitest';
import { HttpPromotionPricingClient } from '../src/modules/promotion-pricing/internal/http-promotion-client.js';
import { InMemoryPromotionStore } from '../src/modules/promotion-pricing/internal/in-memory-promotion-store.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../src/errors/app-error.js';

describe('HttpPromotionPricingClient', () => {
  const adminActor: AuthorizedActor = {
    userId: 'admin-1',
    role: 'ADMINISTRATOR',
    tenantId: 'platform-tenant',
  };

  const merchantActor: AuthorizedActor = {
    userId: 'merchant-user-1',
    role: 'MERCHANT',
    tenantId: 'merchant-123',
  };

  const samplePromoDto = {
    id: 'promo-1',
    name: 'Summer Sale 20%',
    description: '20% off all orders',
    merchantTenantId: 'merchant-123',
    code: 'SUMMER20',
    discountType: 'PERCENTAGE' as const,
    discountValue: 20,
    currency: 'USD',
    scope: 'ORDER' as const,
    targetIds: [],
    minOrderAmount: 50,
    maxDiscountAmount: 100,
    startsAt: new Date().toISOString(),
    expiresAt: null,
    status: 'ACTIVE' as const,
    usageLimitTotal: 100,
    usageLimitPerCustomer: 1,
    currentUsageCount: 0,
    firstOrderOnly: false,
    stackable: false,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('creates promotion via HTTP POST with actor headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => samplePromoDto,
    });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.createPromotion(merchantActor, {
      name: 'Summer Sale 20%',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      code: 'SUMMER20',
      startsAt: new Date().toISOString(),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://promotions-service:4005/v1/promotions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'merchant-user-1',
          'x-tenant-id': 'merchant-123',
          'x-user-role': 'MERCHANT',
        }),
      }),
    );
    expect(result.id).toBe('promo-1');
    expect(result.code).toBe('SUMMER20');
  });

  it('gets promotion by ID via HTTP GET', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => samplePromoDto,
    });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.getPromotion(adminActor, 'promo-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://promotions-service:4005/v1/promotions/promo-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-user-id': 'admin-1',
          'x-user-role': 'ADMINISTRATOR',
        }),
      }),
    );
    expect(result.id).toBe('promo-1');
  });

  it('lists promotions with query filters via HTTP GET', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [samplePromoDto],
    });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.listPromotions(merchantActor, {
      merchantTenantId: 'merchant-123',
      includePlatform: true,
      status: 'ACTIVE',
      limit: 10,
      offset: 0,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://promotions-service:4005/v1/promotions?merchantTenantId=merchant-123&includePlatform=true&status=ACTIVE&limit=10&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toHaveLength(1);
  });

  it('updates promotion via HTTP PATCH', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...samplePromoDto, discountValue: 25 }),
    });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.updatePromotion(merchantActor, 'promo-1', {
      discountValue: 25,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://promotions-service:4005/v1/promotions/promo-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ discountValue: 25 }),
      }),
    );
    expect(result.discountValue).toBe(25);
  });

  it('previews discounts via HTTP POST /v1/promotions/preview', async () => {
    const previewResponse = {
      appliedPromotions: [],
      subtotalAmount: 100,
      totalDiscountAmount: 20,
      itemDiscounts: [{ listingId: 'listing-1', discountAmount: 20 }],
      merchantDiscounts: { 'merchant-123': 20 },
      finalTotalAmount: 80,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => previewResponse,
    });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.previewDiscounts(merchantActor, {
      items: [
        {
          listingId: 'listing-1',
          skuId: 'sku-1',
          merchantTenantId: 'merchant-123',
          quantity: 1,
          unitPriceAmount: 100,
          lineTotalAmount: 100,
        },
      ],
      couponCode: 'SUMMER20',
      currency: 'USD',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://promotions-service:4005/v1/promotions/preview',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.totalDiscountAmount).toBe(20);
    expect(result.finalTotalAmount).toBe(80);
  });

  it('applies and removes coupon to/from checkout session', async () => {
    const applyResponse = {
      discountAmount: 20,
      totalAmount: 80,
      couponCode: 'SUMMER20',
      appliedPromotions: [],
    };
    const removeResponse = {
      discountAmount: 0,
      totalAmount: 100,
      couponCode: null,
      appliedPromotions: [],
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => applyResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => removeResponse,
      });

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const applied = await client.applyCouponToCheckout(merchantActor, 'chk-1', 'SUMMER20');
    expect(applied.discountAmount).toBe(20);
    expect(applied.couponCode).toBe('SUMMER20');

    const removed = await client.removeCouponFromCheckout(merchantActor, 'chk-1');
    expect(removed.discountAmount).toBe(0);
    expect(removed.couponCode).toBeNull();
  });

  it('properly maps 400, 403, 404, 409 HTTP status codes to Domain Errors', async () => {
    const makeErrorClient = (status: number, message: string) =>
      new HttpPromotionPricingClient({
        baseUrl: 'http://promotions-service:4005',
        fetchFn: vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => ({ message }),
        }) as unknown as typeof fetch,
      });

    await expect(
      makeErrorClient(400, 'Invalid promotion parameters').getPromotion(adminActor, 'p1'),
    ).rejects.toThrow(ValidationError);

    await expect(
      makeErrorClient(403, 'Permission denied').getPromotion(merchantActor, 'p1'),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      makeErrorClient(404, 'Promotion not found').getPromotion(adminActor, 'non-existent'),
    ).rejects.toThrow(NotFoundError);

    await expect(
      makeErrorClient(409, 'Coupon code already exists').getPromotion(adminActor, 'p1'),
    ).rejects.toThrow(ConflictError);
  });

  it('falls back to InMemoryPromotionStore when HTTP network call fails', async () => {
    const fallbackStore = new InMemoryPromotionStore();
    fallbackStore.seedPromotions([samplePromoDto]);

    const failingFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new HttpPromotionPricingClient({
      baseUrl: 'http://promotions-service:4005',
      fetchFn: failingFetch as unknown as typeof fetch,
      fallbackEngine: fallbackStore,
    });

    const result = await client.getPromotion(adminActor, 'promo-1');
    expect(result.id).toBe('promo-1');
    expect(result.name).toBe('Summer Sale 20%');

    const listResult = await client.listPromotions(adminActor);
    expect(listResult).toHaveLength(1);
  });
});
