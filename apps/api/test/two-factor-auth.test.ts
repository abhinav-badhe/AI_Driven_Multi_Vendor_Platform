import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { registerIdentityRoutes } from '../src/http/identity-routes.js';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { generateTotpCode } from '../src/modules/identity/internal/totp-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'test-secret-key-min-16chars';
function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('Two-Factor Authentication (2FA) Service & HTTP Contract', () => {
  let db: DatabaseConnection;
  let service: IdentityService;
  let app: FastifyInstance;

  async function registerAndVerify(email: string, pass: string) {
    const reg = await service.register({
      email,
      password: pass,
      tenantName: 'Test Tenant',
      role: 'CUSTOMER',
    });
    const token = await service.createEmailVerificationToken(reg.userId);
    await service.verifyEmail(token);
    return reg;
  }

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    service = new IdentityService(db, makeLogger(), TOKEN_SECRET);
    app = Fastify();
    app.register(fastifyCookie);
    app.register(fastifyCors, { origin: ['http://localhost:3000'], credentials: true });

    app.addHook('onRequest', async (req) => {
      req.correlationId = 'test-corr-id';
      req.requestId = 'test-req-id';
      req.logger = makeLogger();
    });

    registerIdentityRoutes(app, service);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('1. GET /auth/2fa/status returns false by default for new user', async () => {
    await registerAndVerify('user1@example.com', 'password123');
    const loginRes = await service.login({ email: 'user1@example.com', password: 'password123' });
    expect('accessToken' in loginRes).toBe(true);
    const accessToken = (loginRes as any).accessToken;

    const res = await app.inject({
      method: 'GET',
      url: '/auth/2fa/status',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.isEnabled).toBe(false);
  });

  it('2. POST /auth/2fa/setup generates secret, otpauthUri, and 10 recovery codes', async () => {
    const user = await registerAndVerify('user2@example.com', 'password123');
    const loginRes = (await service.login({ email: 'user2@example.com', password: 'password123' })) as any;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/2fa/setup',
      headers: { authorization: `Bearer ${loginRes.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.secret).toBeDefined();
    expect(typeof body.secret).toBe('string');
    expect(body.otpAuthUri).toContain('otpauth://totp/');
    expect(body.otpAuthUri).toContain(encodeURIComponent('user2@example.com'));
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Status is still false until confirmed with first code
    const status = await service.get2FAStatus(user.userId);
    expect(status.isEnabled).toBe(false);
  });

  it('3. POST /auth/2fa/enable activates 2FA with valid TOTP code and rejects invalid code', async () => {
    const user = await registerAndVerify('user3@example.com', 'password123');
    const loginRes = (await service.login({ email: 'user3@example.com', password: 'password123' })) as any;

    const setupData = await service.setup2FA(user.userId);

    // Reject wrong code
    const failRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/enable',
      headers: { authorization: `Bearer ${loginRes.accessToken}` },
      payload: { code: '000000' },
    });
    expect(failRes.statusCode).toBe(400);

    // Accept valid TOTP code
    const validCode = generateTotpCode(setupData.secret);
    const successRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/enable',
      headers: { authorization: `Bearer ${loginRes.accessToken}` },
      payload: { code: validCode },
    });
    expect(successRes.statusCode).toBe(200);

    const status = await service.get2FAStatus(user.userId);
    expect(status.isEnabled).toBe(true);
  });

  it('4. Login requires 2FA challenge when enabled and completes via TOTP code', async () => {
    const user = await registerAndVerify('user4@example.com', 'password123');
    const setupData = await service.setup2FA(user.userId);
    const validCode = generateTotpCode(setupData.secret);
    await service.enable2FA(user.userId, validCode);

    // Step 1: Initial password login returns 2FA challenge
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user4@example.com', password: 'password123' },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challengeBody = JSON.parse(challengeRes.payload);
    expect(challengeBody.requires2FA).toBe(true);
    expect(challengeBody.tempToken).toBeDefined();
    expect(challengeBody.accessToken).toBeUndefined();

    // Step 2: Invalid 2FA code fails
    const failRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify-login',
      payload: { tempToken: challengeBody.tempToken, code: '999999' },
    });
    expect(failRes.statusCode).toBe(401);

    // Step 3: Valid 2FA code completes login and sets refresh cookie
    const currentCode = generateTotpCode(setupData.secret);
    const successRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify-login',
      payload: { tempToken: challengeBody.tempToken, code: currentCode },
    });
    expect(successRes.statusCode).toBe(200);
    const successBody = JSON.parse(successRes.payload);
    expect(successBody.accessToken).toBeDefined();
    expect(successRes.headers['set-cookie']).toBeDefined();
  });

  it('5. Login challenge completes using single-use backup recovery code and prevents code reuse', async () => {
    const user = await registerAndVerify('user5@example.com', 'password123');
    const setupData = await service.setup2FA(user.userId);
    const validCode = generateTotpCode(setupData.secret);
    await service.enable2FA(user.userId, validCode);

    const recoveryCode = setupData.recoveryCodes[0]!;

    // Initial password login
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user5@example.com', password: 'password123' },
    });
    const { tempToken } = JSON.parse(challengeRes.payload);

    // Consume recovery code
    const recoveryLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify-login',
      payload: { tempToken, code: recoveryCode },
    });
    expect(recoveryLoginRes.statusCode).toBe(200);
    expect(JSON.parse(recoveryLoginRes.payload).accessToken).toBeDefined();

    // Second login attempt using the same recovery code must FAIL
    const challengeRes2 = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user5@example.com', password: 'password123' },
    });
    const { tempToken: tempToken2 } = JSON.parse(challengeRes2.payload);

    const reuseRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify-login',
      payload: { tempToken: tempToken2, code: recoveryCode },
    });
    expect(reuseRes.statusCode).toBe(401);
  });

  it('6. POST /auth/2fa/disable deactivates 2FA with password confirmation', async () => {
    const user = await registerAndVerify('user6@example.com', 'password123');
    const setupData = await service.setup2FA(user.userId);
    const validCode = generateTotpCode(setupData.secret);
    await service.enable2FA(user.userId, validCode);

    // Initial login via 2FA
    const challengeRes = await service.login({ email: 'user6@example.com', password: 'password123' });
    expect('requires2FA' in challengeRes).toBe(true);
    const tempToken = (challengeRes as any).tempToken;
    const tokens = await service.verify2FALogin(tempToken, generateTotpCode(setupData.secret));

    // Reject disable with wrong password
    const failRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { password: 'wrongpassword' },
    });
    expect(failRes.statusCode).toBe(401);

    // Successfully disable with correct password
    const disableRes = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { password: 'password123' },
    });
    expect(disableRes.statusCode).toBe(200);

    const status = await service.get2FAStatus(user.userId);
    expect(status.isEnabled).toBe(false);

    // Subsequent login goes directly through without 2FA
    const normalLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user6@example.com', password: 'password123' },
    });
    expect(normalLoginRes.statusCode).toBe(200);
    const normalBody = JSON.parse(normalLoginRes.payload);
    expect(normalBody.accessToken).toBeDefined();
    expect(normalBody.requires2FA).toBeUndefined();
  });
});
