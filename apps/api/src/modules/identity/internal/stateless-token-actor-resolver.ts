import type { AuthorizedActor, Role } from '../rbac/policy.js';
import { HmacTokenService, type TokenService } from './token-service.js';

export interface IIdentityActorResolver {
  resolveActiveActor(token: string): Promise<AuthorizedActor | null>;
  verifyAccessToken(token: string): AuthorizedActor | null;
  resolveFromHeaders?(headers: Record<string, string | string[] | undefined>): AuthorizedActor | null;
}

/**
 * Stateless Token Actor Resolver.
 *
 * Verifies access tokens statelessly in microservice or API Gateway environments
 * by validating cryptographic signatures and expiration timestamps without
 * querying the PostgreSQL database (users / tenant_memberships tables).
 */
export class StatelessTokenActorResolver implements IIdentityActorResolver {
  private readonly tokenService: TokenService;

  constructor(tokenServiceOrSecret: TokenService | string) {
    if (typeof tokenServiceOrSecret === 'string') {
      this.tokenService = new HmacTokenService({ accessTokenSecret: tokenServiceOrSecret });
    } else {
      this.tokenService = tokenServiceOrSecret;
    }
  }

  verifyAccessToken(token: string): AuthorizedActor | null {
    const payload = this.tokenService.verifyAccessToken(token);
    if (!payload) return null;

    const role = payload.role as Role;
    if (!['ADMINISTRATOR', 'MERCHANT', 'CUSTOMER'].includes(role)) {
      return null;
    }

    return {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role,
    };
  }

  async resolveActiveActor(token: string): Promise<AuthorizedActor | null> {
    return this.verifyAccessToken(token);
  }
}

/**
 * Gateway Header Actor Resolver.
 *
 * Resolves identity context from trusted reverse-proxy / API Gateway forwarded headers
 * (x-user-id, x-tenant-id, x-user-role) with fallback to access token verification.
 */
export class GatewayHeaderActorResolver implements IIdentityActorResolver {
  constructor(private readonly fallbackResolver?: IIdentityActorResolver) {}

  resolveFromHeaders(headers: Record<string, string | string[] | undefined>): AuthorizedActor | null {
    const rawUserId = headers['x-user-id'];
    const rawTenantId = headers['x-tenant-id'];
    const rawRole = headers['x-user-role'];

    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;
    const roleStr = Array.isArray(rawRole) ? rawRole[0] : rawRole;

    if (
      userId &&
      tenantId &&
      roleStr &&
      ['ADMINISTRATOR', 'MERCHANT', 'CUSTOMER'].includes(roleStr)
    ) {
      return {
        userId: userId.trim(),
        tenantId: tenantId.trim(),
        role: roleStr.trim() as Role,
      };
    }

    return null;
  }

  verifyAccessToken(token: string): AuthorizedActor | null {
    return this.fallbackResolver ? this.fallbackResolver.verifyAccessToken(token) : null;
  }

  async resolveActiveActor(token: string): Promise<AuthorizedActor | null> {
    return this.fallbackResolver ? this.fallbackResolver.resolveActiveActor(token) : null;
  }
}
