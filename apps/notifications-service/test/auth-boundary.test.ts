import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { HmacTokenVerifier } from '../src/auth/token-verifier.js';
import { createAuthMiddleware, requireRoles } from '../src/auth/auth-middleware.js';
import { UnauthorizedError, ForbiddenError } from '../src/errors/app-error.js';

describe('Authentication Boundary (Decoupled from Monolith User Database)', () => {
  const secret = 'super-secret-jwt-key-for-tests-12345';
  const verifier = new HmacTokenVerifier(secret);

  function makeToken(payload: Record<string, unknown>, key: string = secret): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHash('sha256')
      .update(`${header}.${body}.${key}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  it('successfully verifies token signature independently without querying database', () => {
    const token = makeToken({
      sub: 'usr-123',
      tid: 'tenant-abc',
      rol: 'ADMINISTRATOR',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const actor = verifier.verifyToken(token);
    expect(actor).not.toBeNull();
    expect(actor?.userId).toBe('usr-123');
    expect(actor?.tenantId).toBe('tenant-abc');
    expect(actor?.role).toBe('ADMINISTRATOR');
  });

  it('rejects tokens signed with wrong secret key', () => {
    const token = makeToken(
      { sub: 'usr-123', tid: 'tenant-abc', rol: 'ADMINISTRATOR' },
      'wrong-secret-key',
    );

    const actor = verifier.verifyToken(token);
    expect(actor).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = makeToken({
      sub: 'usr-123',
      tid: 'tenant-abc',
      rol: 'ADMINISTRATOR',
      exp: Math.floor(Date.now() / 1000) - 300, // expired 5 mins ago
    });

    const actor = verifier.verifyToken(token);
    expect(actor).toBeNull();
  });

  it('createAuthMiddleware attaches actor to FastifyRequest', async () => {
    const middleware = createAuthMiddleware(verifier);
    const validToken = makeToken({ sub: 'usr-1', tid: 'ten-1', rol: 'CUSTOMER' });

    const req: any = {
      headers: {
        authorization: `Bearer ${validToken}`,
      },
    };
    const reply: any = {};

    await middleware(req, reply);
    expect(req.actor).toBeDefined();
    expect(req.actor.userId).toBe('usr-1');
  });

  it('createAuthMiddleware rejects missing or invalid header', async () => {
    const middleware = createAuthMiddleware(verifier);
    const req1: any = { headers: {} };
    await expect(middleware(req1, {} as any)).rejects.toThrow(UnauthorizedError);

    const req2: any = { headers: { authorization: 'Bearer invalid.token.signature' } };
    await expect(middleware(req2, {} as any)).rejects.toThrow(UnauthorizedError);
  });

  it('requireRoles verifies user role or throws ForbiddenError', async () => {
    const adminCheck = requireRoles('ADMINISTRATOR');

    const customerReq: any = { actor: { userId: 'u1', tenantId: 't1', role: 'CUSTOMER' } };
    await expect(adminCheck(customerReq, {} as any)).rejects.toThrow(ForbiddenError);

    const adminReq: any = { actor: { userId: 'u2', tenantId: 't1', role: 'ADMINISTRATOR' } };
    await expect(adminCheck(adminReq, {} as any)).resolves.toBeUndefined();
  });
});
