import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import { MerchantService } from './internal/merchant-service.js';
import { InMemoryMerchantStore } from './internal/in-memory-merchant-store.js';
import {
  HttpMerchantClient,
  type HttpMerchantClientOptions,
} from './internal/http-merchant-client.js';
import type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
  MerchantVerificationStatus,
  IMerchantProfileReader,
  IMerchantService,
} from './internal/merchant-models.js';

export type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
  MerchantVerificationStatus,
  IMerchantProfileReader,
  IMerchantService,
  HttpMerchantClientOptions,
};

import type { ISecurityAuditService } from '../identity/index.js';

export interface MerchantModule {
  readonly contextName: 'merchant';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    audit?: ISecurityAuditService,
  ): MerchantService;
  createInMemoryStore(): InMemoryMerchantStore;
  createHttpClient(serviceUrl: string, options?: HttpMerchantClientOptions): HttpMerchantClient;
}

export const merchantModule: MerchantModule = {
  contextName: 'merchant',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    audit?: ISecurityAuditService,
  ): MerchantService {
    return new MerchantService(db, logger, audit);
  },
  createInMemoryStore(): InMemoryMerchantStore {
    return new InMemoryMerchantStore();
  },
  createHttpClient(serviceUrl: string, options?: HttpMerchantClientOptions): HttpMerchantClient {
    return new HttpMerchantClient(serviceUrl, options);
  },
};

// Re-export implementations
export { MerchantService, InMemoryMerchantStore, HttpMerchantClient };
