import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdentityService } from '../src/modules/identity/internal/identity-service.js';
import { JsonLogger } from '../src/observability/logger.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'test-secret-key-min-16chars';

function makeLogger() {
  return new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
}

describe('Token Rotation & Reuse Detection', () => {
  let db: DatabaseConnection;
  let service: IdentityService;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    service = new IdentityService(db, makeLogger(), TOKEN_SECRET);
  });

  afterEach(async () => {
    await db.close();
  });

  async function registerAndLogin() {
    await service.register({
      email: 'rotation@example.com',
      password: 'rotationPassword123',
      tenantName: 'Rotation Store',
      role: 'MERCHANT',
    });
    return service.login({ email: 'rotation@example.com', password: 'rotationPassword123' });
  }

  it('refresh issues a new token pair and old refresh token is rotated', async () => {
    const firstTokens = await registerAndLogin();
    const secondTokens = await service.refresh(firstTokens.refreshToken);

    expect(secondTokens.refreshToken).not.toBe(firstTokens.refreshToken);
    expect(secondTokens.accessToken).toBeDefined();
  });

  it('old rotated refresh token cannot be reused (reuse detection)', async () => {
    const firstTokens = await registerAndLogin();
    await service.refresh(firstTokens.refreshToken); // rotate

    // Attempt to reuse the old token — should trigger revocation
    await expect(service.refresh(firstTokens.refreshToken)).rejects.toThrow('revoked');
  });

  it('using a reused token revokes the entire token family (all sessions)', async () => {
    const firstTokens = await registerAndLogin();
    const secondTokens = await service.refresh(firstTokens.refreshToken);

    // Detect reuse of first token — should revoke family
    await expect(service.refresh(firstTokens.refreshToken)).rejects.toThrow('revoked');

    // The second (valid) token should now also be revoked
    await expect(service.refresh(secondTokens.refreshToken)).rejects.toThrow('revoked');
  });

  it('logout revokes all tokens and subsequent refresh fails', async () => {
    const tokens = await registerAndLogin();
    const actor = service.verifyAccessToken(tokens.accessToken);
    expect(actor).not.toBeNull();

    await service.logout(tokens.refreshToken);

    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow('revoked');
  });

  it('revoked refresh token cannot authenticate', async () => {
    const tokens = await registerAndLogin();
    await service.logout(tokens.refreshToken);
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow();
  });

  describe('Concurrent Refresh Concurrency Safety', () => {
    it('handles concurrent refresh requests safely: at most one succeeds, losing attempt triggers reuse rejection', async () => {
      const initialTokens = await registerAndLogin();

      // Launch two refresh attempts concurrently with the exact same raw token
      const [res1, res2] = await Promise.allSettled([
        service.refresh(initialTokens.refreshToken),
        service.refresh(initialTokens.refreshToken),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly at most one caller can ever successfully rotate
      expect(fulfilled.length).toBeLessThanOrEqual(1);

      // The losing request MUST be rejected
      expect(rejected.length).toBeGreaterThanOrEqual(1);

      const rejectedReasons = rejected.map((r) => (r as PromiseRejectedResult).reason?.message);
      expect(rejectedReasons.some((msg) => msg?.includes('revoked'))).toBe(true);

      // Verify database state: no duplicate active refresh tokens were created for the same token family
      const initialTokenHash = service['tokenService'].hashToken(initialTokens.refreshToken);
      const initialRecord = await db.query<{ family_id: string }>(
        `SELECT family_id FROM refresh_tokens WHERE token_hash = $1`,
        [initialTokenHash],
      );
      const familyId = initialRecord.rows[0]?.family_id;

      const tokensInDb = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM refresh_tokens WHERE family_id = $1 AND is_rotated = FALSE AND is_revoked = FALSE`,
        [familyId],
      );
      // At most 1 valid replacement token exists in this family (or 0 if family revoked due to race)
      expect(Number(tokensInDb.rows[0]?.count)).toBeLessThanOrEqual(1);
    });
  });
});

