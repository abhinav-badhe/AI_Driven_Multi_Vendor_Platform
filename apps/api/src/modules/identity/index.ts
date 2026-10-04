import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import { IdentityService } from './internal/identity-service.js';
import type { AuthorizedActor } from './rbac/policy.js';
import type { AuthTokenPair, AuthenticatedIdentity } from './internal/identity-service.js';

export type { AuthorizedActor, AuthTokenPair, AuthenticatedIdentity };
export { RbacPolicy } from './rbac/policy.js';
export type { Role, Permission } from './rbac/policy.js';

export interface IdentityModule {
  readonly contextName: 'identity';
  createService(db: DatabaseConnection, logger: Logger, tokenSecret: string): IdentityService;
  verifyAccessToken(service: IdentityService, token: string): AuthorizedActor | null;
}

export const identityModule: IdentityModule = {
  contextName: 'identity',
  createService(db: DatabaseConnection, logger: Logger, tokenSecret: string): IdentityService {
    return new IdentityService(db, logger, tokenSecret);
  },
  verifyAccessToken(service: IdentityService, token: string): AuthorizedActor | null {
    return service.verifyAccessToken(token);
  },
};

import { SecurityAuditService } from './internal/security-audit-service.js';
import { ScryptPasswordHasher } from './internal/password-hasher.js';
export type { AuditEventType, AuditEventMetadata } from './internal/security-audit-service.js';

// Re-export services so callers using the module can type and instantiate them correctly
export { IdentityService, SecurityAuditService, ScryptPasswordHasher };

