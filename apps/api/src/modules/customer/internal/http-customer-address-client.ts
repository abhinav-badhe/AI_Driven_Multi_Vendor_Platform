import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  CustomerAddressDto,
  AddressSnapshot,
  ICustomerAddressReader,
} from './customer-address-models.js';
import type { Logger } from '../../../observability/logger.js';
import { ExternalServiceError, NotFoundError } from '../../../errors/app-error.js';

export interface HttpCustomerAddressClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackReader?: ICustomerAddressReader | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpCustomerAddressClient - Remote Customer Microservice HTTP Address Client.
 *
 * Implements ICustomerAddressReader to fetch customer addresses and default
 * delivery details from a standalone customer-service microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Passes identity context (x-user-id, x-tenant-id, x-user-role) for cross-service authorization.
 * - Graceful fallback to local in-memory or SQL address reader on remote failure.
 */
export class HttpCustomerAddressClient implements ICustomerAddressReader {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackReader?: ICustomerAddressReader | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpCustomerAddressClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackReader = options.fallbackReader;
    this.logger = options.logger;
  }

  getFallbackReader(): ICustomerAddressReader | undefined {
    return this.fallbackReader;
  }

  async getAddressById(actor: AuthorizedActor, id: string): Promise<CustomerAddressDto> {
    try {
      const res = await this.request<{ address: CustomerAddressDto }>(
        `/v1/customers/addresses/${encodeURIComponent(id)}`,
        actor,
      );
      return res.address;
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackReader) {
        this.logger?.warn('HttpCustomerAddressClient: getAddressById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          addressId: id,
          userId: actor.userId,
        });
        return this.fallbackReader.getAddressById(actor, id);
      }
      throw err;
    }
  }

  async getDefaultAddress(actor: AuthorizedActor): Promise<CustomerAddressDto | null> {
    try {
      const res = await this.request<{ address: CustomerAddressDto | null }>(
        `/v1/customers/addresses/default`,
        actor,
      );
      return res.address;
    } catch (err) {
      if (this.fallbackReader) {
        this.logger?.warn('HttpCustomerAddressClient: getDefaultAddress failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          userId: actor.userId,
        });
        return this.fallbackReader.getDefaultAddress(actor);
      }
      throw err;
    }
  }

  toSnapshot(address: CustomerAddressDto): AddressSnapshot {
    return {
      id: address.id,
      addressId: address.id,
      label: address.label,
      recipientName: address.recipientName,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      country: address.country,
      latitude: address.latitude,
      longitude: address.longitude,
      googlePlaceId: address.googlePlaceId,
      formattedAddress: address.formattedAddress,
      sourceType: 'SAVED_ADDRESS',
    };
  }

  private async request<T = unknown>(path: string, actor: AuthorizedActor): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-user-id': actor.userId,
          'x-tenant-id': actor.tenantId,
          'x-user-role': actor.role,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new NotFoundError(`Resource not found at ${path}`);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Ignore
        }
        throw new ExternalServiceError(
          `Customer service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ExternalServiceError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Customer service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with customer service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
