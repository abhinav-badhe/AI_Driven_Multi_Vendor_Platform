import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  ISettlementService,
  FinancialSummaryDto,
  LedgerEntryDto,
  SettlementDto,
  IngestOrderFinancialsInput,
  IngestRefundFinancialsInput,
  CreateAdjustmentInput,
  CalculateSettlementInput,
  TransitionSettlementInput,
  ListLedgerEntriesFilter,
  IngestOrderFinancialsResultDto,
  IngestRefundFinancialsResultDto,
  CreateAdjustmentResultDto,
} from './settlement-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpSettlementClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: ISettlementService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpSettlementClient - Remote Settlement & Ledger Microservice HTTP Client.
 *
 * Implements ISettlementService to delegate multi-vendor financial accounting,
 * double-entry ledger entries, merchant payouts, and financial summaries to a standalone settlement service over HTTP.
 */
export class HttpSettlementClient implements ISettlementService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: ISettlementService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpSettlementClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): ISettlementService | undefined {
    return this.fallbackService;
  }

  async getFinancialSummary(
    actor: AuthorizedActor,
    merchantId: string,
    currency = 'INR',
  ): Promise<FinancialSummaryDto> {
    try {
      const query = currency ? `?currency=${encodeURIComponent(currency)}` : '';
      return await this.request<FinancialSummaryDto>(
        'GET',
        `/settlement/merchants/${encodeURIComponent(merchantId)}/summary${query}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getFinancialSummary(actor, merchantId, currency);
      }
      throw err;
    }
  }

  async listLedgerEntries(
    actor: AuthorizedActor,
    merchantId: string,
    filter?: ListLedgerEntriesFilter,
  ): Promise<LedgerEntryDto[]> {
    const params = new URLSearchParams();
    if (filter?.entryType) params.set('entryType', filter.entryType);
    if (filter?.sourceType) params.set('sourceType', filter.sourceType);
    if (filter?.sourceId) params.set('sourceId', filter.sourceId);
    if (filter?.startDate) params.set('startDate', filter.startDate);
    if (filter?.endDate) params.set('endDate', filter.endDate);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      const response = await this.request<{ entries: LedgerEntryDto[] } | LedgerEntryDto[]>(
        'GET',
        `/settlement/merchants/${encodeURIComponent(merchantId)}/ledger${query}`,
        actor,
      );
      if (Array.isArray(response)) {
        return response;
      }
      return response.entries ?? [];
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listLedgerEntries(actor, merchantId, filter);
      }
      throw err;
    }
  }

  async getSettlement(actor: AuthorizedActor, settlementId: string): Promise<SettlementDto> {
    try {
      return await this.request<SettlementDto>(
        'GET',
        `/settlement/settlements/${encodeURIComponent(settlementId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getSettlement(actor, settlementId);
      }
      throw err;
    }
  }

  async ingestOrderFinancials(
    actor: AuthorizedActor,
    input: IngestOrderFinancialsInput,
  ): Promise<IngestOrderFinancialsResultDto> {
    try {
      return await this.request<IngestOrderFinancialsResultDto>(
        'POST',
        '/settlement/ingest/order',
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.ingestOrderFinancials(actor, input);
      }
      throw err;
    }
  }

  async ingestRefundFinancials(
    actor: AuthorizedActor,
    input: IngestRefundFinancialsInput,
  ): Promise<IngestRefundFinancialsResultDto> {
    try {
      return await this.request<IngestRefundFinancialsResultDto>(
        'POST',
        '/settlement/ingest/refund',
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.ingestRefundFinancials(actor, input);
      }
      throw err;
    }
  }

  async createAdjustment(
    actor: AuthorizedActor,
    input: CreateAdjustmentInput,
  ): Promise<CreateAdjustmentResultDto> {
    try {
      return await this.request<CreateAdjustmentResultDto>(
        'POST',
        '/settlement/adjustments',
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createAdjustment(actor, input);
      }
      throw err;
    }
  }

  async calculateSettlement(
    actor: AuthorizedActor,
    input: CalculateSettlementInput,
  ): Promise<SettlementDto> {
    try {
      return await this.request<SettlementDto>(
        'POST',
        '/settlement/settlements/calculate',
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.calculateSettlement(actor, input);
      }
      throw err;
    }
  }

  async transitionSettlementStatus(
    actor: AuthorizedActor,
    settlementId: string,
    input: TransitionSettlementInput,
  ): Promise<SettlementDto> {
    try {
      return await this.request<SettlementDto>(
        'POST',
        `/settlement/settlements/${encodeURIComponent(settlementId)}/transition`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote settlement service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.transitionSettlementStatus(actor, settlementId, input);
      }
      throw err;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    actor?: AuthorizedActor,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (actor) {
      headers['x-user-id'] = actor.userId;
      headers['x-tenant-id'] = actor.tenantId;
      headers['x-user-role'] = actor.role;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await this.fetchFn(url, init);

      if (!response.ok) {
        const errorBody = await response.text();
        this.handleErrorResponse(response.status, errorBody);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          `Settlement service request timed out after ${this.timeoutMs}ms`,
          'SETTLEMENT_SERVICE_TIMEOUT',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private isFallbackEligible(err: unknown): boolean {
    if (err instanceof ExternalServiceError) return true;
    if (err instanceof TypeError && err.message.includes('fetch')) return true;
    if (err instanceof Error) {
      return (
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('fetch failed') ||
        err.message.includes('timeout')
      );
    }
    return false;
  }

  private handleErrorResponse(status: number, errorBody: string): never {
    let message = errorBody;
    let code = 'EXTERNAL_SERVICE_ERROR';

    try {
      const parsed = JSON.parse(errorBody) as {
        error?: { code?: string; message?: string };
        message?: string;
      };
      if (parsed.error?.message) message = parsed.error.message;
      else if (parsed.message) message = parsed.message;
      if (parsed.error?.code) code = parsed.error.code;
    } catch {
      // Body not JSON
    }

    if (status === 400) {
      throw new ValidationError(message);
    }
    if (status === 401) {
      throw new UnauthorizedError(message);
    }
    if (status === 403) {
      throw new ForbiddenError(message);
    }
    if (status === 404) {
      throw new NotFoundError(message);
    }
    if (status === 409) {
      if (code === 'INVALID_STATE_TRANSITION') {
        throw new InvalidStateTransitionError(message);
      }
      throw new ConflictError(message);
    }
    throw new ExternalServiceError(
      `Remote settlement service returned HTTP ${status}: ${message}`,
      'SETTLEMENT_SERVICE_ERROR',
    );
  }
}
