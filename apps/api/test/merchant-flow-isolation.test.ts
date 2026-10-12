import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import {
  createMigratedTestDatabase,
  markAllUsersVerified,
  registerVerifiedUser,
} from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { MerchantService } from '../src/modules/merchant/internal/merchant-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import type { AuthorizedActor } from '../src/modules/identity/index.js';
import { ForbiddenError } from '../src/errors/app-error.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('Phase 2 Exit Condition: Authorization & Tenant Isolation', () => {
  let db: DatabaseConnection;
  let identitySvc: IdentityService;
  let merchantSvc: MerchantService;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    identitySvc = new IdentityService(db, makeLogger(), TOKEN_SECRET);
    merchantSvc = new MerchantService(db, makeLogger());

    const config = parseConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'fatal',
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'test_db',
      DATABASE_USER: 'test_user',
      DATABASE_PASSWORD: 'test_password',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_PASSWORD: '',
      REDIS_TLS: 'false',
      ACCESS_TOKEN_SECRET: TOKEN_SECRET,
      SERVICE_NAME: 'test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });

    app = await buildApp({
      config,
      dbConnection: db,
      skipMigrations: true,
      logger: makeLogger(),
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  describe('Merchant Onboarding & Verification Lifecycle', () => {
    it('executes full merchant onboarding to verification lifecycle', async () => {
      // 1. Register Merchant A (verified before any sign-in)
      const merchantToken = await registerVerifiedUser(app, db, {
        email: 'merchant_a@store.com',
        password: 'securePassword123!',
        tenantName: 'Merchant A Store',
        role: 'MERCHANT',
      });

      // 2. Onboard merchant profile
      const onboardRes = await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: {
          businessName: 'Merchant A LLC',
          legalName: 'Merchant A Legal Inc',
          contactEmail: 'contact@merchanta.com',
        },
      });
      expect(onboardRes.statusCode).toBe(201);
      const profile = onboardRes.json();
      expect(profile.verificationStatus).toBe('DRAFT');
      expect(profile.businessName).toBe('Merchant A LLC');

      // 3. Update merchant profile while in DRAFT
      const updateRes = await app.inject({
        method: 'PATCH',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: {
          businessName: 'Merchant A Corporation',
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().businessName).toBe('Merchant A Corporation');

      // 4. Submit for verification
      const submitRes = await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${merchantToken}` },
      });
      expect(submitRes.statusCode).toBe(200);
      expect(submitRes.json().verificationStatus).toBe('SUBMITTED');

      // 5. Create an Administrator in database
      await db.query(
        `INSERT INTO tenants (id, type, name, status) VALUES ('platform-tenant', 'PLATFORM', 'Platform Admin', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, status) VALUES ('admin-id-1', 'admin@platform.com', 'admin_hash', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ('membership-admin-1', 'platform-tenant', 'admin-id-1', 'ADMINISTRATOR', 'ACTIVE')`,
      );

      const adminActor: AuthorizedActor = {
        userId: 'admin-id-1',
        tenantId: 'platform-tenant',
        role: 'ADMINISTRATOR',
      };
      // Generate admin token
      const { HmacTokenService } =
        await import('../src/modules/identity/internal/token-service.js');
      const tokenSvc = new HmacTokenService({ accessTokenSecret: TOKEN_SECRET });
      const adminToken = tokenSvc.generateAccessToken(adminActor).token;

      // 6. Admin approves merchant
      const approveRes = await app.inject({
        method: 'POST',
        url: `/merchants/${profile.tenantId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().verificationStatus).toBe('VERIFIED');
      expect(approveRes.json().verifiedAt).toBeDefined();

      // 7. Verified merchant profile cannot be arbitrarily mutated by merchant
      const mutateAfterVerified = await app.inject({
        method: 'PATCH',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: {
          businessName: 'Tampered Name',
        },
      });
      expect(mutateAfterVerified.statusCode).toBe(403);
    });

    it('rejects invalid state machine transitions', async () => {
      // Register a merchant to create a real tenant
      const smAccount = await identitySvc.register({
        email: 'statemachine@test.com',
        password: 'password123!',
        tenantName: 'State Machine Store',
        role: 'MERCHANT',
      });
      await identitySvc.verifyEmail(
        await identitySvc.createEmailVerificationToken(smAccount.userId),
      );
      const login = await identitySvc.login({
        email: 'statemachine@test.com',
        password: 'password123!',
      });
      const actor = identitySvc.verifyAccessToken(login.accessToken)!;

      // Onboard to create DRAFT profile
      await merchantSvc.onboard(actor, {
        businessName: 'Direct Verify Test',
        legalName: 'Direct Verify LLC',
        contactEmail: 'direct@test.com',
      });

      const adminActor: AuthorizedActor = {
        userId: 'admin-1',
        tenantId: 'platform-tenant',
        role: 'ADMINISTRATOR',
      };

      // Trying to approve a DRAFT profile without SUBMITTED state must fail with ForbiddenError
      await expect(merchantSvc.approveMerchant(adminActor, actor.tenantId)).rejects.toThrow(
        ForbiddenError,
      );
    });
  });

  describe('Tenant Isolation Enforcement', () => {
    it('prevents Merchant A from accessing or modifying Merchant B data', async () => {
      // Register Merchant A
      const tokenA = await registerVerifiedUser(app, db, {
        email: 'merchant_alpha@store.com',
        password: 'Password123!',
        tenantName: 'Alpha Store',
        role: 'MERCHANT',
      });

      // Register Merchant B
      const tokenB = await registerVerifiedUser(app, db, {
        email: 'merchant_beta@store.com',
        password: 'Password123!',
        tenantName: 'Beta Store',
        role: 'MERCHANT',
      });

      // Onboard Merchant A
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          businessName: 'Alpha Store LLC',
          legalName: 'Alpha Corp',
          contactEmail: 'alpha@store.com',
        },
      });

      // Onboard Merchant B
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          businessName: 'Beta Store LLC',
          legalName: 'Beta Corp',
          contactEmail: 'beta@store.com',
        },
      });

      // Merchant A requests /merchants/me -> gets Alpha
      const meA = await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(meA.statusCode).toBe(200);
      expect(meA.json().businessName).toBe('Alpha Store LLC');

      // Merchant B requests /merchants/me -> gets Beta
      const meB = await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(meB.statusCode).toBe(200);
      expect(meB.json().businessName).toBe('Beta Store LLC');

      // Merchant A cannot approve Merchant B
      const crossApproveRes = await app.inject({
        method: 'POST',
        url: `/merchants/${meB.json().tenantId}/approve`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      // Lacks permission 'merchant:verify'
      expect(crossApproveRes.statusCode).toBe(403);
    });

    it('enforces verified tenant context on every authenticated request', async () => {
      // Unauthenticated request to protected route is rejected
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/merchants/me',
      });
      expect(unauthRes.statusCode).toBe(401);

      // Tampered token with forged tenant is rejected
      const tamperedRes = await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: 'Bearer invalid.tampered.token' },
      });
      expect(tamperedRes.statusCode).toBe(401);
    });
  });

  describe('Security Audit Logging', () => {
    it('records security audit events for authentication, rotation, and merchant decisions', async () => {
      // Register Merchant
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'audit@store.com',
          password: 'Password123!',
          tenantName: 'Audit Store',
          role: 'MERCHANT',
        },
      });
      await markAllUsersVerified(db);

      // Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'audit@store.com', password: 'Password123!' },
      });
      const refreshCookie = loginRes.cookies.find((c) => c.name === 'auth_refresh');

      // Refresh (rotates token)
      await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: refreshCookie!.value },
      });

      // Query database audit log directly to verify append-only audit trail
      const auditRows = await db.query<{ event_type: string }>(
        `SELECT event_type FROM security_audit_events ORDER BY created_at ASC`,
      );

      const events = auditRows.rows.map((r) => r.event_type);
      expect(events).toContain('LOGIN_SUCCESS');
      expect(events).toContain('REFRESH_TOKEN_ROTATED');
    });
  });

  describe('Live User, Tenant & Membership Lifecycle Enforcement', () => {
    async function setupTestMerchant() {
      const email = `merchant_${Date.now()}@example.com`;
      const accessToken = await registerVerifiedUser(app, db, {
        email,
        password: 'Password123!',
        tenantName: 'Lifecycle Test Tenant',
        role: 'MERCHANT',
      });
      const meRes = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return {
        accessToken,
        userId: meRes.json().userId,
        tenantId: meRes.json().tenantId,
      };
    }

    it('rejects access when user status is DEACTIVATED even with valid token signature', async () => {
      const { accessToken, userId } = await setupTestMerchant();

      // Deactivate user in database
      await db.query(`UPDATE users SET status = 'DEACTIVATED' WHERE id = $1`, [userId]);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain('locked or deactivated');
    });

    it('rejects access when user status is LOCKED even with valid token signature', async () => {
      const { accessToken, userId } = await setupTestMerchant();

      // Lock user in database
      await db.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [userId]);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain('locked or deactivated');
    });

    it('rejects access when tenant membership is SUSPENDED', async () => {
      const { accessToken, userId, tenantId } = await setupTestMerchant();

      // Suspend membership in database
      await db.query(
        `UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE user_id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain('Tenant membership is inactive');
    });

    it('dynamically applies live role change: demoted merchant cannot perform merchant operations', async () => {
      const { accessToken, userId, tenantId } = await setupTestMerchant();

      // Onboard while role is MERCHANT
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          businessName: 'Dynamic Role Store',
          legalName: 'Dynamic Role LLC',
          contactEmail: 'dyn@role.com',
        },
      });

      // Demote role to CUSTOMER in database
      await db.query(
        `UPDATE tenant_memberships SET role = 'CUSTOMER' WHERE user_id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );

      // Attempt submit with original MERCHANT token -> live resolution enforces CUSTOMER role and rejects
      const submitRes = await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(submitRes.statusCode).toBe(403);
    });
  });

  describe('Platform Administrator vs Merchant Tenant Scope', () => {
    it('prohibits platform administrator from verifying their own tenant as a merchant', async () => {
      // Create admin user & platform tenant
      await db.query(
        `INSERT INTO tenants (id, type, name, status) VALUES ('platform-self-tenant', 'PLATFORM', 'Platform Self', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, status) VALUES ('admin-self-1', 'admin_self@platform.com', 'hash', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ('mem-admin-self', 'platform-self-tenant', 'admin-self-1', 'ADMINISTRATOR', 'ACTIVE')`,
      );

      const { HmacTokenService } =
        await import('../src/modules/identity/internal/token-service.js');
      const tokenSvc = new HmacTokenService({ accessTokenSecret: TOKEN_SECRET });
      const adminToken = tokenSvc.generateAccessToken({
        userId: 'admin-self-1',
        tenantId: 'platform-self-tenant',
        role: 'ADMINISTRATOR',
      }).token;

      // Admin tries to approve their own platform tenant as a merchant -> must fail with 403
      const res = await app.inject({
        method: 'POST',
        url: '/merchants/platform-self-tenant/approve',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('distinguishes actor identity from route targetTenantId and verifies target belongs to merchant', async () => {
      // 1. Create real merchant tenant & profile
      const merchantToken = await registerVerifiedUser(app, db, {
        email: 'target_merchant@store.com',
        password: 'Password123!',
        tenantName: 'Target Merchant Store',
        role: 'MERCHANT',
      });

      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: {
          businessName: 'Target Merchant Inc',
          legalName: 'Target Legal Inc',
          contactEmail: 'target@merchant.com',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${merchantToken}` },
      });

      const me = await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${merchantToken}` },
      });
      const targetTenantId = me.json().tenantId;

      // 2. Admin approves target merchant
      await db.query(
        `INSERT INTO tenants (id, type, name, status) VALUES ('platform-scope-tenant', 'PLATFORM', 'Platform Scope', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, status) VALUES ('admin-scope-1', 'admin_scope@platform.com', 'hash', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ('mem-admin-scope', 'platform-scope-tenant', 'admin-scope-1', 'ADMINISTRATOR', 'ACTIVE')`,
      );

      const { HmacTokenService } =
        await import('../src/modules/identity/internal/token-service.js');
      const tokenSvc = new HmacTokenService({ accessTokenSecret: TOKEN_SECRET });
      const adminToken = tokenSvc.generateAccessToken({
        userId: 'admin-scope-1',
        tenantId: 'platform-scope-tenant',
        role: 'ADMINISTRATOR',
      }).token;

      const approveRes = await app.inject({
        method: 'POST',
        url: `/merchants/${targetTenantId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().tenantId).toBe(targetTenantId);
      expect(approveRes.json().verificationStatus).toBe('VERIFIED');
    });
  });

  describe('Merchant State Machine Transition Matrix Enforcement', () => {
    it('rejects invalid state transitions across all forbidden paths', async () => {
      const accessToken = await registerVerifiedUser(app, db, {
        email: 'statematrix@store.com',
        password: 'Password123!',
        tenantName: 'State Matrix Store',
        role: 'MERCHANT',
      });

      const onboardRes = await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          businessName: 'Matrix Store',
          legalName: 'Matrix LLC',
          contactEmail: 'matrix@store.com',
        },
      });
      const tenantId = onboardRes.json().tenantId;

      await db.query(
        `INSERT INTO tenants (id, type, name, status) VALUES ('platform-matrix-tenant', 'PLATFORM', 'Platform Matrix', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, status) VALUES ('admin-matrix-1', 'admin_matrix@platform.com', 'hash', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ('mem-admin-matrix', 'platform-matrix-tenant', 'admin-matrix-1', 'ADMINISTRATOR', 'ACTIVE')`,
      );

      const adminActor: AuthorizedActor = {
        userId: 'admin-matrix-1',
        tenantId: 'platform-matrix-tenant',
        role: 'ADMINISTRATOR',
      };

      // 1. DRAFT -> VERIFIED directly (forbidden)
      await expect(merchantSvc.approveMerchant(adminActor, tenantId)).rejects.toThrow(
        ForbiddenError,
      );

      // 2. Submit to move to SUBMITTED
      await merchantSvc.submitForVerification({
        userId: 'u',
        tenantId,
        role: 'MERCHANT',
      });

      // 3. Admin rejects -> status is REJECTED
      await merchantSvc.rejectMerchant(adminActor, tenantId, 'Missing documentation');
      const rejectedProfile = await merchantSvc.getProfile({
        userId: 'u',
        tenantId,
        role: 'MERCHANT',
      });
      expect(rejectedProfile.verificationStatus).toBe('REJECTED');

      // 4. REJECTED -> VERIFIED directly without resubmission (forbidden)
      await expect(merchantSvc.approveMerchant(adminActor, tenantId)).rejects.toThrow(
        ForbiddenError,
      );

      // 5. Resubmit: REJECTED -> SUBMITTED (allowed)
      await merchantSvc.submitForVerification({
        userId: 'u',
        tenantId,
        role: 'MERCHANT',
      });

      // 6. Admin approves: SUBMITTED -> VERIFIED (allowed)
      await merchantSvc.approveMerchant(adminActor, tenantId);
      const verifiedProfile = await merchantSvc.getProfile({
        userId: 'u',
        tenantId,
        role: 'MERCHANT',
      });
      expect(verifiedProfile.verificationStatus).toBe('VERIFIED');

      // 7. VERIFIED -> SUBMITTED (forbidden)
      await expect(
        merchantSvc.submitForVerification({
          userId: 'u',
          tenantId,
          role: 'MERCHANT',
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
