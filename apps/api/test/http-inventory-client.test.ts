import { describe, it, expect, vi } from 'vitest';
import { HttpInventoryClient } from '../src/modules/inventory/internal/http-inventory-client.js';
import { InMemoryInventoryStore } from '../src/modules/inventory/internal/in-memory-inventory-store.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  ForbiddenError,
  InvalidStateTransitionError,
  InsufficientInventoryError,
  ExternalServiceError,
} from '../src/errors/app-error.js';

describe('HttpInventoryClient', () => {
  const merchantActor: AuthorizedActor = {
    userId: 'merchant-1',
    role: 'MERCHANT',
    tenantId: 'tenant-merchant-1',
  };

  const sampleItemDto = {
    id: 'inv-123',
    tenantId: 'tenant-merchant-1',
    listingId: 'lst-456',
    skuId: 'sku-789',
    onHandQuantity: 100,
    reservedQuantity: 10,
    nonSellableQuantity: 5,
    availableQuantity: 85,
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  const sampleReservationDto = {
    id: 'res-101',
    inventoryId: 'inv-123',
    tenantId: 'tenant-merchant-1',
    customerTenantId: 'cust-tenant-1',
    quantity: 2,
    status: 'ACTIVE' as const,
    idempotencyKey: 'idmp-key-1',
    expiresAt: null,
    consumedAt: null,
    releasedAt: null,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  it('initializes inventory via HTTP POST with identity headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => sampleItemDto,
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.initializeInventory(merchantActor, {
      listingId: 'lst-456',
      initialOnHandQuantity: 100,
      initialNonSellableQuantity: 5,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://inventory-service:4006/inventory',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'merchant-1',
          'x-tenant-id': 'tenant-merchant-1',
          'x-user-role': 'MERCHANT',
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result.id).toBe('inv-123');
    expect(result.availableQuantity).toBe(85);
  });

  it('retrieves availability, inventory by listing ID, and inventory by ID', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/inventory/availability/lst-456')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            listingId: 'lst-456',
            skuId: 'sku-789',
            isAvailable: true,
            availableQuantity: 85,
          }),
        });
      }
      if (url.includes('/inventory/by-listing/lst-456')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleItemDto,
        });
      }
      if (url.includes('/inventory/inv-123')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleItemDto,
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const availability = await client.getAvailabilityByListingId('lst-456');
    expect(availability.isAvailable).toBe(true);
    expect(availability.availableQuantity).toBe(85);

    const byListing = await client.getInventoryByListingId(merchantActor, 'lst-456');
    expect(byListing.id).toBe('inv-123');

    const byId = await client.getInventoryById(merchantActor, 'inv-123');
    expect(byId.id).toBe('inv-123');
  });

  it('adjusts stock and non-sellable levels via HTTP POST', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/stock/increase')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleItemDto, onHandQuantity: 120, availableQuantity: 105 }),
        });
      }
      if (url.includes('/stock/decrease')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleItemDto, onHandQuantity: 90, availableQuantity: 75 }),
        });
      }
      if (url.includes('/non-sellable')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleItemDto, nonSellableQuantity: 10, availableQuantity: 80 }),
        });
      }
      return Promise.resolve({ ok: false, status: 400 });
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const increased = await client.increaseStock(merchantActor, 'inv-123', 20, 'Restocked');
    expect(increased.onHandQuantity).toBe(120);

    const decreased = await client.decreaseStock(merchantActor, 'inv-123', 10, 'Damaged');
    expect(decreased.onHandQuantity).toBe(90);

    const adjusted = await client.adjustNonSellable(merchantActor, 'inv-123', 10);
    expect(adjusted.nonSellableQuantity).toBe(10);
  });

  it('handles reservation lifecycle: create, get, release, and consume', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (init.method === 'POST' && url.endsWith('/inventory/reservations')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => sampleReservationDto,
        });
      }
      if (init.method === 'GET' && url.includes('/inventory/reservations/res-101')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleReservationDto,
        });
      }
      if (init.method === 'POST' && url.includes('/reservations/res-101/release')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleReservationDto, status: 'RELEASED' }),
        });
      }
      if (init.method === 'POST' && url.includes('/reservations/res-101/consume')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleReservationDto, status: 'CONSUMED' }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const reservation = await client.createReservation(merchantActor, {
      inventoryId: 'inv-123',
      quantity: 2,
      idempotencyKey: 'idmp-key-1',
    });
    expect(reservation.id).toBe('res-101');
    expect(reservation.status).toBe('ACTIVE');

    const fetched = await client.getReservationById(merchantActor, 'res-101');
    expect(fetched.id).toBe('res-101');

    const released = await client.releaseReservation(merchantActor, 'res-101');
    expect(released.status).toBe('RELEASED');

    const consumed = await client.consumeReservation(merchantActor, 'res-101');
    expect(consumed.status).toBe('CONSUMED');
  });

  it('translates 400 to ValidationError and 403 to ForbiddenError', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'quantity must be a positive integer' }),
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(client.increaseStock(merchantActor, 'inv-123', -5)).rejects.toThrowError(
      ValidationError,
    );

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Tenant mismatch' }),
    });

    await expect(client.decreaseStock(merchantActor, 'inv-123', 5)).rejects.toThrowError(
      ForbiddenError,
    );
  });

  it('translates 409 insufficient stock to InsufficientInventoryError and 422 to InvalidStateTransitionError', async () => {
    const mockFetch = vi.fn();
    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        message: 'Insufficient inventory available: requested 50, available 10',
      }),
    });
    await expect(
      client.createReservation(merchantActor, { inventoryId: 'inv-123', quantity: 50 }),
    ).rejects.toThrowError(InsufficientInventoryError);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Cannot release non-active reservation' }),
    });
    await expect(client.releaseReservation(merchantActor, 'res-101')).rejects.toThrowError(
      InvalidStateTransitionError,
    );
  });

  it('falls back to local InMemoryInventoryStore on 500 server error', async () => {
    const fallback = new InMemoryInventoryStore();
    const seeded = await fallback.initializeInventory(merchantActor, {
      listingId: 'lst-fallback-1',
      initialOnHandQuantity: 50,
      initialNonSellableQuantity: 0,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackService: fallback,
    });

    expect(client.getFallbackService()).toBe(fallback);

    // Call getInventoryById - remote returns 500, fallback responds seamlessly
    const result = await client.getInventoryById(merchantActor, seeded.id);
    expect(result.id).toBe(seeded.id);
    expect(result.onHandQuantity).toBe(50);
  });

  it('falls back to local InMemoryInventoryStore on network error', async () => {
    const fallback = new InMemoryInventoryStore();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackService: fallback,
    });

    const created = await client.initializeInventory(merchantActor, {
      listingId: 'lst-net-fallback',
      initialOnHandQuantity: 100,
      initialNonSellableQuantity: 10,
    });

    expect(created.listingId).toBe('lst-net-fallback');
    expect(created.availableQuantity).toBe(90);
  });

  it('throws ExternalServiceError on network failure when no fallback is configured', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(client.getAvailabilityByListingId('lst-1')).rejects.toThrowError(
      ExternalServiceError,
    );
  });

  it('throws ExternalServiceError on request timeout', async () => {
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );

    const client = new HttpInventoryClient('http://inventory-service:4006', {
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await expect(client.getAvailabilityByListingId('lst-1')).rejects.toThrowError(
      ExternalServiceError,
    );
  });
});
