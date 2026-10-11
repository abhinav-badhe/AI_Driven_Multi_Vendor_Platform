import { describe, it, expect, vi } from 'vitest';
import {
  HttpCustomerAddressClient,
  type CustomerAddressDto,
  type ICustomerAddressReader,
} from '../src/modules/customer/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import { ExternalServiceError, NotFoundError } from '../src/errors/app-error.js';

describe('Domain 7: Customer Address Decoupled HTTP Client', () => {
  const customerActor: AuthorizedActor = {
    userId: 'user-c1',
    tenantId: 'tenant-1',
    role: 'CUSTOMER',
  };

  const sampleAddress: CustomerAddressDto = {
    id: 'addr-101',
    customerId: 'user-c1',
    tenantId: 'tenant-1',
    label: 'Home',
    recipientName: 'Alice Smith',
    phone: '+15551234567',
    addressLine1: '123 Main St',
    addressLine2: 'Apt 4B',
    landmark: 'Near Central Park',
    city: 'Metropolis',
    state: 'NY',
    postalCode: '10001',
    country: 'USA',
    latitude: 40.7128,
    longitude: -74.006,
    googlePlaceId: 'ChIJ-some-place-id',
    formattedAddress: '123 Main St, Apt 4B, Metropolis, NY 10001',
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  describe('HttpCustomerAddressClient', () => {
    it('fetches address by ID with actor authorization headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ address: sampleAddress }),
      });

      const client = new HttpCustomerAddressClient('http://customer-service:4080', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.getAddressById(customerActor, 'addr-101');
      expect(result.id).toBe('addr-101');
      expect(result.recipientName).toBe('Alice Smith');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://customer-service:4080/v1/customers/addresses/addr-101',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'x-user-id': 'user-c1',
            'x-tenant-id': 'tenant-1',
            'x-user-role': 'CUSTOMER',
          }),
        }),
      );
    });

    it('fetches default address with actor authorization headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ address: sampleAddress }),
      });

      const client = new HttpCustomerAddressClient('http://customer-service:4080', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.getDefaultAddress(customerActor);
      expect(result?.id).toBe('addr-101');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://customer-service:4080/v1/customers/addresses/default',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'x-user-id': 'user-c1',
            'x-tenant-id': 'tenant-1',
            'x-user-role': 'CUSTOMER',
          }),
        }),
      );
    });

    it('throws NotFoundError when remote endpoint returns 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const client = new HttpCustomerAddressClient('http://customer-service:4080', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getAddressById(customerActor, 'non-existent')).rejects.toThrowError(
        NotFoundError,
      );
    });

    it('falls back to fallbackReader on network error', async () => {
      const fallbackReader: ICustomerAddressReader = {
        getAddressById: vi.fn().mockResolvedValue(sampleAddress),
        getDefaultAddress: vi.fn().mockResolvedValue(sampleAddress),
        toSnapshot: vi.fn(),
      };

      const failingFetch = vi.fn().mockRejectedValue(new Error('Network connection refused'));

      const client = new HttpCustomerAddressClient('http://customer-service:4080', {
        fetchFn: failingFetch as unknown as typeof fetch,
        fallbackReader,
      });

      const address = await client.getAddressById(customerActor, 'addr-101');
      expect(address.id).toBe('addr-101');
      expect(fallbackReader.getAddressById).toHaveBeenCalledWith(customerActor, 'addr-101');

      const defaultAddr = await client.getDefaultAddress(customerActor);
      expect(defaultAddr?.id).toBe('addr-101');
      expect(fallbackReader.getDefaultAddress).toHaveBeenCalledWith(customerActor);
    });

    it('throws ExternalServiceError when service fails with 500 and no fallbackReader', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const client = new HttpCustomerAddressClient('http://customer-service:4080', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getAddressById(customerActor, 'addr-101')).rejects.toThrowError(
        ExternalServiceError,
      );
    });

    it('transforms CustomerAddressDto to AddressSnapshot properly', () => {
      const client = new HttpCustomerAddressClient('http://customer-service:4080');
      const snapshot = client.toSnapshot(sampleAddress);

      expect(snapshot).toEqual({
        id: 'addr-101',
        addressId: 'addr-101',
        label: 'Home',
        recipientName: 'Alice Smith',
        phone: '+15551234567',
        addressLine1: '123 Main St',
        addressLine2: 'Apt 4B',
        landmark: 'Near Central Park',
        city: 'Metropolis',
        state: 'NY',
        postalCode: '10001',
        country: 'USA',
        latitude: 40.7128,
        longitude: -74.006,
        googlePlaceId: 'ChIJ-some-place-id',
        formattedAddress: '123 Main St, Apt 4B, Metropolis, NY 10001',
        sourceType: 'SAVED_ADDRESS',
      });
    });
  });
});
