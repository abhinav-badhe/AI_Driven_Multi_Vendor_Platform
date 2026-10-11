import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import { IdentityService } from './internal/identity-service.js';
import type { AuthorizedActor } from './rbac/policy.js';
import type { AuthTokenPair, AuthenticatedIdentity, LoginResult, LoginRequires2FAResult } from './internal/identity-service.js';
import {
  type IIdentityActorResolver,
  StatelessTokenActorResolver,
  GatewayHeaderActorResolver,
} from './internal/stateless-token-actor-resolver.js';

export type { AuthorizedActor, AuthTokenPair, AuthenticatedIdentity, IIdentityActorResolver, LoginResult, LoginRequires2FAResult };
export { RbacPolicy } from './rbac/policy.js';
export type { Role, Permission } from './rbac/policy.js';
export { StatelessTokenActorResolver, GatewayHeaderActorResolver };

export interface IdentityModule {
  readonly contextName: 'identity';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    tokenSecret: string,
    audit?: ISecurityAuditService,
  ): IdentityService;
  verifyAccessToken(service: IdentityService, token: string): AuthorizedActor | null;
  createStatelessResolver(tokenSecret: string): StatelessTokenActorResolver;
  createGatewayResolver(fallbackResolver?: IIdentityActorResolver): GatewayHeaderActorResolver;
  createAuditService(db: DatabaseConnection, logger: Logger): SecurityAuditService;
  createInMemoryAuditService(): InMemorySecurityAuditService;
}

export const identityModule: IdentityModule = {
  contextName: 'identity',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    tokenSecret: string,
    audit?: ISecurityAuditService,
  ): IdentityService {
    return new IdentityService(db, logger, tokenSecret, audit);
  },
  verifyAccessToken(service: IdentityService, token: string): AuthorizedActor | null {
    return service.verifyAccessToken(token);
  },
  createStatelessResolver(tokenSecret: string): StatelessTokenActorResolver {
    return new StatelessTokenActorResolver(tokenSecret);
  },
  createGatewayResolver(fallbackResolver?: IIdentityActorResolver): GatewayHeaderActorResolver {
    return new GatewayHeaderActorResolver(fallbackResolver);
  },
  createAuditService(db: DatabaseConnection, logger: Logger): SecurityAuditService {
    return new SecurityAuditService(db, logger);
  },
  createInMemoryAuditService(): InMemorySecurityAuditService {
    return new InMemorySecurityAuditService();
  },
};

import {
  SecurityAuditService,
  InMemorySecurityAuditService,
  type AuditEventType,
  type AuditEventMetadata,
  type ISecurityAuditService,
  type SecurityAuditParams,
  type SecurityAuditEventRecord,
} from './internal/security-audit-service.js';
import { ScryptPasswordHasher } from './internal/password-hasher.js';
import { HmacTokenService } from './internal/token-service.js';
export type {
  AuditEventType,
  AuditEventMetadata,
  ISecurityAuditService,
  SecurityAuditParams,
  SecurityAuditEventRecord,
};

// Re-export services so callers using the module can type and instantiate them correctly
export {
  IdentityService,
  SecurityAuditService,
  InMemorySecurityAuditService,
  ScryptPasswordHasher,
  HmacTokenService,
};

