import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import { MerchantService } from './internal/merchant-service.js';
import type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
} from './internal/merchant-service.js';

export type { MerchantProfileDto, OnboardMerchantInput, UpdateMerchantProfileInput };
export type { MerchantVerificationStatus } from './internal/merchant-repository.js';

export interface MerchantModule {
  readonly contextName: 'merchant';
  createService(db: DatabaseConnection, logger: Logger): MerchantService;
}

export const merchantModule: MerchantModule = {
  contextName: 'merchant',
  createService(db: DatabaseConnection, logger: Logger): MerchantService {
    return new MerchantService(db, logger);
  },
};

// Re-export MerchantService type for typed usage
export { MerchantService };
