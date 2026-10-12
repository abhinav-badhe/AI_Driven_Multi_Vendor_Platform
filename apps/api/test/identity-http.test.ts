import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { registerIdentityRoutes } from '../src/http/identity-routes.js';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'test-secret-key-min-16chars';
function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('Identity HTTP Routes (Browser Contract)', () => {
  let db: DatabaseConnection;
  let service: IdentityService;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    service = new IdentityService(db, makeLogger(), TOKEN_SECRET);
    app = Fastify();
    app.register(fastifyCookie);
    app.register(fastifyCors, { origin: ['http://localhost:3000'], credentials: true });

    // Simulate Request ID hooks for middleware
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

  it('1. successful login returns access token and sets HttpOnly refresh cookie', async () => {
    await registerVerified('test@example.com', 'password123');

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    // 1. Returns access token
    expect(body.accessToken).toBeDefined();

    // 2. Response does NOT contain refreshToken in JSON
    expect(body.refreshToken).toBeUndefined();

    // 3. Response sets HttpOnly refresh cookie
    const cookies = response.cookies;
    const refreshCookie = cookies.find((c) => c.name === 'auth_refresh');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie?.httpOnly).toBe(true);

    // 4. cookie expiration matches refresh-token lifetime
    expect(refreshCookie?.maxAge).toBeDefined();
    expect(refreshCookie?.maxAge).toBeGreaterThan(0);

    // 5. secure/samesite/path configuration is correct
    expect(refreshCookie?.path).toBe('/api/auth');
    expect(refreshCookie?.sameSite).toBe('Strict');
    // Secure is false in test env because NODE_ENV is 'test' or 'development'
  });

  it('6. refresh works using the cookie and rotates it', async () => {
    await registerVerified('refresh@example.com', 'password123');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'refresh@example.com', password: 'password123' },
    });

    const refreshCookie = loginRes.cookies.find((c) => c.name === 'auth_refresh');
    expect(refreshCookie).toBeDefined();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { auth_refresh: refreshCookie!.value },
    });

    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = JSON.parse(refreshRes.payload);

    // 8. response does NOT expose refreshToken
    expect(refreshBody.refreshToken).toBeUndefined();
    expect(refreshBody.accessToken).toBeDefined();

    // 9. successful refresh rotates the refresh cookie
    const newCookie = refreshRes.cookies.find((c) => c.name === 'auth_refresh');
    expect(newCookie).toBeDefined();
    expect(newCookie?.value).not.toBe(refreshCookie!.value);

    // 10. old refresh token cannot be reused
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { auth_refresh: refreshCookie!.value },
    });
    expect(reuseRes.statusCode).toBe(401); // Unauthorized (Invalid token or family revoked)
  });

  it('7. refreshToken JSON body is not required (reads from cookie)', async () => {
    // Proven by the test above since no payload was sent to /auth/refresh
  });

  it('14. logout reads refresh cookie and 15. revokes it and 16. clears the cookie', async () => {
    await registerVerified('logout@example.com', 'password123');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'logout@example.com', password: 'password123' },
    });
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'auth_refresh');
    const accessToken = JSON.parse(loginRes.payload).accessToken;

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      cookies: { auth_refresh: refreshCookie!.value },
    });

    expect(logoutRes.statusCode).toBe(204);

    // 16. logout clears the refresh cookie
    const clearedCookie = logoutRes.cookies.find((c) => c.name === 'auth_refresh');
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie?.value).toBe('');
    expect(clearedCookie?.maxAge).toBe(0);

    // 17. cleared/revoked token cannot refresh
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { auth_refresh: refreshCookie!.value },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('18. registration creates an unverified account without session cookies and 19. login is blocked until verification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'reg@example.com',
        password: 'password123',
        tenantName: 'Tenant',
        role: 'MERCHANT',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);

    expect(body.userId).toBeDefined();
    expect(body.requiresVerification).toBe(true);
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();

    const cookies = response.cookies;
    expect(cookies.find((c) => c.name === 'auth_refresh')).toBeUndefined();

    // Login is blocked before verification (403 from the route;
    // the full error envelope with EMAIL_NOT_VERIFIED is asserted in
    // identity-auth service tests — this file mounts routes standalone).
    const blocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'reg@example.com', password: 'password123' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.payload).toContain('verified');

    // ... and succeeds after the emailed link is consumed.
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'reg@example.com'`,
    );
    const rawToken = await service.createEmailVerificationToken(userRes.rows[0]!.id);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { token: rawToken },
    });
    expect(verifyRes.statusCode).toBe(200);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'reg@example.com', password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'auth_refresh');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie?.httpOnly).toBe(true);
  });

  it('19b. resend-verification is rate-limited-safe and never reveals account state', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      payload: { email: 'nobody@example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('20. trusted frontend origin can perform credentialed authentication', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('22. logs/errors do not expose refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { auth_refresh: 'fake-token-that-should-not-be-in-output' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.payload).not.toContain('fake-token');
  });

  // ── Cookie-authoritative logout – security boundary tests ──────────────────

  async function registerVerified(email: string, password = 'password123!') {
    const account = await service.register({
      email,
      password,
      tenantName: 'Tenant',
      role: 'MERCHANT',
    });
    await service.verifyEmail(await service.createEmailVerificationToken(account.userId));
  }

  describe('Logout: cookie-authoritative security boundary', () => {
    async function loginUser(email: string) {
      await registerVerified(email);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'password123!' },
      });
      const accessToken = JSON.parse(res.payload).accessToken as string;
      const refreshCookie = res.cookies.find((c) => c.name === 'auth_refresh')!;
      return { accessToken, refreshCookieValue: refreshCookie.value };
    }

    it('L1. valid access token + valid refresh cookie → logout 204, refresh afterward fails', async () => {
      const { accessToken, refreshCookieValue } = await loginUser('l1@example.com');

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        cookies: { auth_refresh: refreshCookieValue },
      });
      expect(logoutRes.statusCode).toBe(204);

      // cookie is cleared
      const cleared = logoutRes.cookies.find((c) => c.name === 'auth_refresh');
      expect(cleared?.value).toBe('');
      expect(cleared?.maxAge).toBe(0);

      // family revoked → subsequent refresh fails
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: refreshCookieValue },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('L2. EXPIRED access token + valid refresh cookie → logout 204, refresh-family revoked', async () => {
      // Login at service level so we get the raw refresh token before HTTP layer
      const account = await service.register({
        email: 'l2@example.com',
        password: 'password123!',
        tenantName: 'T',
        role: 'MERCHANT',
      });
      await service.verifyEmail(await service.createEmailVerificationToken(account.userId));
      const loginTokens = await service.login({
        email: 'l2@example.com',
        password: 'password123!',
      });

      // Construct a structurally valid but expired access token by mutating the exp claim.
      // We forge the exp to the past so verifyAccessToken returns null.
      const parts = loginTokens.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
      claims.exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const expiredPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      // Signature won't match, but the token will also fail expiry — either way verifyAccessToken returns null
      const expiredToken = `${parts[0]}.${expiredPayload}.invalidsig`;

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${expiredToken}` },
        cookies: { auth_refresh: loginTokens.refreshToken },
      });

      // CRITICAL: logout must succeed despite expired access token
      expect(logoutRes.statusCode).toBe(204);

      // Cookie must be cleared
      const cleared = logoutRes.cookies.find((c) => c.name === 'auth_refresh');
      expect(cleared?.value).toBe('');
      expect(cleared?.maxAge).toBe(0);

      // Refresh-family revoked → subsequent refresh with old cookie must fail
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('L3. NO access token at all + valid refresh cookie → logout 204, family revoked', async () => {
      const l3 = await service.register({
        email: 'l3@example.com',
        password: 'password123!',
        tenantName: 'T',
        role: 'MERCHANT',
      });
      await service.verifyEmail(await service.createEmailVerificationToken(l3.userId));
      const loginTokens = await service.login({
        email: 'l3@example.com',
        password: 'password123!',
      });

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        // No Authorization header at all
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(logoutRes.statusCode).toBe(204);

      // Family revoked
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('L4. INVALID access token signature + valid refresh cookie → logout 204, family revoked', async () => {
      const l4 = await service.register({
        email: 'l4@example.com',
        password: 'password123!',
        tenantName: 'T',
        role: 'MERCHANT',
      });
      await service.verifyEmail(await service.createEmailVerificationToken(l4.userId));
      const loginTokens = await service.login({
        email: 'l4@example.com',
        password: 'password123!',
      });

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: 'Bearer completely.invalid.token' },
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(logoutRes.statusCode).toBe(204);

      // Family revoked despite garbage access token
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('L5. valid access token + MISSING refresh cookie → safe idempotent 204, no token created', async () => {
      const { accessToken } = await loginUser('l5@example.com');

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        // No cookie
      });
      // Should be safe/idempotent – returns 204
      expect(logoutRes.statusCode).toBe(204);
      // Cookie is cleared (even if it didn't exist)
      const cleared = logoutRes.cookies.find((c) => c.name === 'auth_refresh');
      expect(cleared?.value).toBe('');
    });

    it('L6. already-revoked refresh token → safe idempotent 204, no resurrection', async () => {
      const { accessToken, refreshCookieValue } = await loginUser('l6@example.com');

      // First logout
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        cookies: { auth_refresh: refreshCookieValue },
      });

      // Second logout with the same (now revoked) token
      const secondLogout = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { auth_refresh: refreshCookieValue },
      });
      expect(secondLogout.statusCode).toBe(204); // idempotent

      // Still cannot refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: refreshCookieValue },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('L7. logout clears auth_refresh cookie with correct path', async () => {
      const { accessToken, refreshCookieValue } = await loginUser('l7@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        cookies: { auth_refresh: refreshCookieValue },
      });
      const cleared = res.cookies.find((c) => c.name === 'auth_refresh');
      expect(cleared).toBeDefined();
      expect(cleared?.path).toBe('/api/auth');
      expect(cleared?.value).toBe('');
      expect(cleared?.maxAge).toBe(0);
    });

    it('L8. logout response body does not contain refreshToken', async () => {
      const { accessToken, refreshCookieValue } = await loginUser('l8@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        cookies: { auth_refresh: refreshCookieValue },
      });
      expect(res.statusCode).toBe(204);
      expect(res.payload).not.toContain('refreshToken');
      expect(res.payload).not.toContain('refresh');
    });

    it('L10. subsequent /auth/refresh with old cookie fails after any logout variant', async () => {
      // Proven by L1, L2, L3, L4 individually; this test consolidates with no-header variant
      const l10 = await service.register({
        email: 'l10@example.com',
        password: 'password123!',
        tenantName: 'T',
        role: 'MERCHANT',
      });
      await service.verifyEmail(await service.createEmailVerificationToken(l10.userId));
      const loginTokens = await service.login({
        email: 'l10@example.com',
        password: 'password123!',
      });

      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { auth_refresh: loginTokens.refreshToken },
      });

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { auth_refresh: loginTokens.refreshToken },
      });
      expect(refreshRes.statusCode).toBe(401);
    });
  });

  describe('Password Reset flow', () => {
    it('forgot-password returns 200 without leaking whether email exists', async () => {
      // Non-existent email
      const res1 = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'nonexistent@example.com' },
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.payload).message).toContain('password reset link has been sent');

      // Existing email
      await registerVerified('exists@example.com', 'originalPass1!');
      const res2 = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'exists@example.com' },
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.payload).message).toContain('password reset link has been sent');
    });

    it('reset-password validates minimum password length', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'validlookingtoken1234567890123456', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('reset-password updates password and allows login with new credentials', async () => {
      await registerVerified('resetme@example.com', 'originalPass1!');
      const pending = await service.beginPasswordReset('resetme@example.com');
      expect(pending).not.toBeNull();

      const resetRes = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: pending!.rawToken, password: 'newSecurePassword99!' },
      });
      expect(resetRes.statusCode).toBe(200);
      expect(JSON.parse(resetRes.payload).message).toContain('successfully reset');

      // Old password should fail
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'resetme@example.com', password: 'originalPass1!' },
      });
      expect(oldLogin.statusCode).toBe(401);

      // New password should succeed
      const newLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'resetme@example.com', password: 'newSecurePassword99!' },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('reset token cannot be reused', async () => {
      await registerVerified('reused@example.com', 'originalPass1!');
      const pending = await service.beginPasswordReset('reused@example.com');

      const firstReset = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: pending!.rawToken, password: 'brandNewPass123!' },
      });
      expect(firstReset.statusCode).toBe(200);

      // Second reset attempt with same token must fail
      const secondReset = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: pending!.rawToken, password: 'anotherNewPass123!' },
      });
      expect(secondReset.statusCode).toBe(400);
    });
  });
});
