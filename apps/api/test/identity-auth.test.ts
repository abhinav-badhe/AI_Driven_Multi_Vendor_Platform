import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'test-secret-key-min-16chars';

function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('Authentication: Identity Service', () => {
  let db: DatabaseConnection;
  let service: IdentityService;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    service = new IdentityService(db, makeLogger(), TOKEN_SECRET);
  });

  afterEach(async () => {
    await db.close();
  });

  it('registers a new unverified account without issuing a session', async () => {
    const account = await service.register({
      email: 'merchant@example.com',
      password: 'secure-password-123',
      tenantName: 'Acme Store',
      role: 'MERCHANT',
    });

    expect(account.userId).toBeDefined();
    expect(account.email).toBe('merchant@example.com');
    expect(account.tenantId).toBeDefined();
  });

  it('blocks password login until the email is verified', async () => {
    await service.register({
      email: 'pending@example.com',
      password: 'secure-password-123',
      tenantName: 'Pending Store',
      role: 'MERCHANT',
    });

    const attempt = await service
      .login({ email: 'pending@example.com', password: 'secure-password-123' })
      .then(
        () => ({ code: 'NO_ERROR' }),
        (err: unknown) => ({ code: (err as { code?: string }).code ?? 'UNKNOWN' }),
      );
    expect(attempt.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verifies email with a valid token and then allows login', async () => {
    const account = await service.register({
      email: 'verified@example.com',
      password: 'secure-password-123',
      tenantName: 'Verified Store',
      role: 'MERCHANT',
    });

    const rawToken = await service.createEmailVerificationToken(account.userId);
    const result = await service.verifyEmail(rawToken);
    expect(result.userId).toBe(account.userId);

    const tokens = await service.login({
      email: 'verified@example.com',
      password: 'secure-password-123',
    });
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
  });

  it('rejects invalid and consumed verification tokens', async () => {
    await expect(service.verifyEmail('not-a-real-token')).rejects.toThrow('invalid or has expired');

    const account = await service.register({
      email: 'once@example.com',
      password: 'secure-password-123',
      tenantName: 'Once Store',
      role: 'MERCHANT',
    });
    const rawToken = await service.createEmailVerificationToken(account.userId);
    await service.verifyEmail(rawToken);
    await expect(service.verifyEmail(rawToken)).rejects.toThrow('invalid or has expired');
  });

  it('rejects duplicate email registration', async () => {
    await service.register({
      email: 'dup@example.com',
      password: 'password-123',
      tenantName: 'Store A',
      role: 'MERCHANT',
    });

    await expect(
      service.register({
        email: 'dup@example.com',
        password: 'password-456',
        tenantName: 'Store B',
        role: 'MERCHANT',
      }),
    ).rejects.toThrow('already exists');
  });

  it('rejects registration with invalid email', async () => {
    await expect(
      service.register({
        email: 'not-an-email',
        password: 'password-123',
        tenantName: 'Store',
        role: 'MERCHANT',
      }),
    ).rejects.toThrow('Invalid email');
  });

  it('rejects registration with short password', async () => {
    await expect(
      service.register({
        email: 'short@example.com',
        password: 'short',
        tenantName: 'Store',
        role: 'MERCHANT',
      }),
    ).rejects.toThrow('at least 8');
  });

  it('successful login returns valid token pair', async () => {
    const account = await service.register({
      email: 'login@example.com',
      password: 'loginPassword123',
      tenantName: 'Login Store',
      role: 'MERCHANT',
    });
    await service.verifyEmail(await service.createEmailVerificationToken(account.userId));

    const tokens = await service.login({
      email: 'login@example.com',
      password: 'loginPassword123',
    });
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
  });

  it('invalid credentials fail generically (no account enumeration)', async () => {
    await expect(
      service.login({ email: 'nonexistent@example.com', password: 'anything' }),
    ).rejects.toThrow('Invalid credentials');
    await expect(
      service.login({ email: 'login@example.com', password: 'wrongpassword' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('access token verification succeeds with valid token', async () => {
    const account = await service.register({
      email: 'verify@example.com',
      password: 'verifyPassword123',
      tenantName: 'Test Tenant',
      role: 'MERCHANT',
    });
    await service.verifyEmail(await service.createEmailVerificationToken(account.userId));
    const tokens = await service.login({
      email: 'verify@example.com',
      password: 'verifyPassword123',
    });
    const actor = service.verifyAccessToken(tokens.accessToken);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe('MERCHANT');
  });

  it('invalid access token returns null', () => {
    expect(service.verifyAccessToken('not.a.valid.token')).toBeNull();
    expect(service.verifyAccessToken('')).toBeNull();
    expect(service.verifyAccessToken('tampered.bad.token')).toBeNull();
  });

  it('expired access token is rejected', async () => {
    // Create a service with 0-second TTL to produce an instantly expired token
    const shortLivedService = new IdentityService(db, makeLogger(), TOKEN_SECRET);
    // Manually forge: the token-service generates a token with exp = now (expired)
    // We verify that a token issued by a service with negative TTL is invalid
    const { HmacTokenService } = await import('../src/modules/identity/internal/token-service.js');
    const expiredSvc = new HmacTokenService({
      accessTokenSecret: TOKEN_SECRET,
      accessTokenTtlSeconds: -1,
    });
    const expiredToken = expiredSvc.generateAccessToken({
      userId: 'u-1',
      tenantId: 't-1',
      role: 'MERCHANT',
    });
    expect(shortLivedService.verifyAccessToken(expiredToken.token)).toBeNull();
  });
});
