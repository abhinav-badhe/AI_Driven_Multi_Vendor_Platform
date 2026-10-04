import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RbacPolicy } from '../src/modules/identity/rbac/policy.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import { ForbiddenError } from '../src/errors/app-error.js';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { MerchantService } from '../src/modules/merchant/internal/merchant-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'test-secret-key-min-16chars';

function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('RBAC Policy', () => {
  it('correctly grants permission to role that has it', () => {
    const admin: AuthorizedActor = { userId: 'u-1', tenantId: 't-1', role: 'ADMINISTRATOR' };
    expect(RbacPolicy.hasPermission(admin, 'merchant:verify')).toBe(true);
    expect(RbacPolicy.hasPermission(admin, 'admin:manage-users')).toBe(true);
  });

  it('denies permission to role that lacks it', () => {
    const merchant: AuthorizedActor = { userId: 'u-2', tenantId: 't-2', role: 'MERCHANT' };
    expect(RbacPolicy.hasPermission(merchant, 'merchant:verify')).toBe(false);
    expect(RbacPolicy.hasPermission(merchant, 'admin:manage-users')).toBe(false);
  });

  it('customer cannot perform merchant operations', () => {
    const customer: AuthorizedActor = { userId: 'u-3', tenantId: 't-3', role: 'CUSTOMER' };
    expect(RbacPolicy.hasPermission(customer, 'merchant:onboard')).toBe(false);
    expect(RbacPolicy.hasPermission(customer, 'merchant:read-own')).toBe(false);
  });

  it('requirePermission throws ForbiddenError on missing permission', () => {
    const merchant: AuthorizedActor = { userId: 'u-2', tenantId: 't-2', role: 'MERCHANT' };
    expect(() => RbacPolicy.requirePermission(merchant, 'merchant:verify')).toThrow(ForbiddenError);
  });

  it('requireTenantMatch throws on cross-tenant access', () => {
    const actor: AuthorizedActor = { userId: 'u-1', tenantId: 'tenant-A', role: 'MERCHANT' };
    expect(() => RbacPolicy.requireTenantMatch(actor, 'tenant-B')).toThrow('Tenant isolation violation');
  });
});

describe('RBAC Integration: Authorization via IdentityService & MerchantService', () => {
  let db: DatabaseConnection;
  let identitySvc: IdentityService;
  let merchantSvc: MerchantService;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    identitySvc = new IdentityService(db, makeLogger(), TOKEN_SECRET);
    merchantSvc = new MerchantService(db, makeLogger());
  });

  afterEach(async () => {
    await db.close();
  });

  it('unauthenticated access is rejected (no valid token)', () => {
    const actor = identitySvc.verifyAccessToken('garbage');
    expect(actor).toBeNull();
  });

  it('authenticated merchant can onboard', async () => {
    await identitySvc.register({
      email: 'merchant-rbac@example.com',
      password: 'securepassword123',
      tenantName: 'RBAC Store',
      role: 'MERCHANT',
    });
    const tokens = await identitySvc.login({ email: 'merchant-rbac@example.com', password: 'securepassword123' });
    const actor = identitySvc.verifyAccessToken(tokens.accessToken);
    expect(actor).not.toBeNull();

    const profile = await merchantSvc.onboard(actor!, {
      businessName: 'RBAC Store Ltd',
      legalName: 'RBAC Store LLC',
      contactEmail: 'contact@rbac-store.com',
    });
    expect(profile.businessName).toBe('RBAC Store Ltd');
  });

  it('customer cannot onboard merchant', async () => {
    const customerActor: AuthorizedActor = {
      userId: 'some-customer-id',
      tenantId: 'customer-tenant-id',
      role: 'CUSTOMER',
    };
    await expect(
      merchantSvc.onboard(customerActor, {
        businessName: 'Bad Actor Store',
        legalName: 'Bad Actor LLC',
        contactEmail: 'bad@actor.com',
      }),
    ).rejects.toThrow();
  });

  it('merchant cannot approve/verify another merchant', async () => {
    const merchantActor: AuthorizedActor = {
      userId: 'merchant-user-id',
      tenantId: 'merchant-tenant-id',
      role: 'MERCHANT',
    };
    await expect(merchantSvc.approveMerchant(merchantActor, 'some-other-tenant')).rejects.toThrow();
  });
});
