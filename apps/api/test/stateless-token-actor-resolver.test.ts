import { describe, it, expect } from 'vitest';
import {
  StatelessTokenActorResolver,
  identityModule,
  HmacTokenService,
} from '../src/modules/identity/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware } from '../src/http/auth-middleware.js';
import { UnauthorizedError } from '../src/errors/app-error.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

describe('Identity Microservice Boundary: Stateless & Gateway Actor Resolvers', () => {
  const SECRET = 'test-access-token-secret-at-least-16-chars';
  const tokenService = new HmacTokenService({ accessTokenSecret: SECRET });

  const validToken = tokenService.generateAccessToken({
    userId: 'user-alpha-1',
    tenantId: 'tenant-omega-1',
    role: 'MERCHANT',
  }).token;

  describe('1. StatelessTokenActorResolver (Zero Database Lookups)', () => {
    it('initializes with a secret string and validates signed access tokens', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);

      const actor = await resolver.resolveActiveActor(validToken);
      expect(actor).not.toBeNull();
      expect(actor?.userId).toBe('user-alpha-1');
      expect(actor?.tenantId).toBe('tenant-omega-1');
      expect(actor?.role).toBe('MERCHANT');

      const verified = resolver.verifyAccessToken(validToken);
      expect(verified).toEqual(actor);
    });

    it('returns null on invalid signatures', async () => {
      const resolver = identityModule.createStatelessResolver(
        'different-secret-that-does-not-match-32c',
      );
      const actor = await resolver.resolveActiveActor(validToken);
      expect(actor).toBeNull();
    });

    it('returns null on malformed token strings', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      expect(await resolver.resolveActiveActor('not-a-token')).toBeNull();
      expect(await resolver.resolveActiveActor('')).toBeNull();
      expect(await resolver.resolveActiveActor('a.b')).toBeNull();
    });

    it('rejects expired access tokens', async () => {
      const shortLivedService = new HmacTokenService({
        accessTokenSecret: SECRET,
        accessTokenTtlSeconds: -10, // expired 10s ago
      });
      const expiredToken = shortLivedService.generateAccessToken({
        userId: 'u-1',
        tenantId: 't-1',
        role: 'CUSTOMER',
      }).token;

      const resolver = new StatelessTokenActorResolver(tokenService);
      const actor = await resolver.resolveActiveActor(expiredToken);
      expect(actor).toBeNull();
    });
  });

  describe('2. GatewayHeaderActorResolver (Edge / Reverse Proxy Propagation)', () => {
    it('extracts actor directly from trusted gateway forwarded headers', () => {
      const resolver = identityModule.createGatewayResolver();

      const headers = {
        'x-user-id': 'gateway-user-99',
        'x-tenant-id': 'gateway-tenant-99',
        'x-user-role': 'ADMINISTRATOR',
      };

      const actor = resolver.resolveFromHeaders(headers);
      expect(actor).not.toBeNull();
      expect(actor?.userId).toBe('gateway-user-99');
      expect(actor?.tenantId).toBe('gateway-tenant-99');
      expect(actor?.role).toBe('ADMINISTRATOR');
    });

    it('returns null when required gateway headers are missing', () => {
      const resolver = identityModule.createGatewayResolver();
      expect(resolver.resolveFromHeaders({ 'x-user-id': 'u-1' })).toBeNull();
      expect(resolver.resolveFromHeaders({ 'x-user-id': 'u-1', 'x-tenant-id': 't-1' })).toBeNull();
      expect(
        resolver.resolveFromHeaders({
          'x-user-id': 'u-1',
          'x-tenant-id': 't-1',
          'x-user-role': 'INVALID_ROLE',
        }),
      ).toBeNull();
    });

    it('falls back to bearer token resolver when headers are absent', async () => {
      const fallback = identityModule.createStatelessResolver(SECRET);
      const resolver = identityModule.createGatewayResolver(fallback);

      const actor = await resolver.resolveActiveActor(validToken);
      expect(actor).not.toBeNull();
      expect(actor?.userId).toBe('user-alpha-1');
    });
  });

  describe('3. Fastify createAuthMiddleware Integration with Actor Resolvers', () => {
    it('authenticates request via StatelessTokenActorResolver', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      const middleware = createAuthMiddleware(resolver);

      const req = {
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await middleware(req, reply);
      expect(req.actor).toBeDefined();
      expect(req.actor?.userId).toBe('user-alpha-1');
      expect(req.actor?.role).toBe('MERCHANT');
    });

    it('authenticates request via GatewayHeaderActorResolver using edge headers', async () => {
      const resolver = identityModule.createGatewayResolver();
      const middleware = createAuthMiddleware(resolver);

      const req = {
        headers: {
          'x-user-id': 'edge-usr-42',
          'x-tenant-id': 'edge-ten-42',
          'x-user-role': 'CUSTOMER',
        },
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await middleware(req, reply);
      expect(req.actor).toBeDefined();
      expect(req.actor?.userId).toBe('edge-usr-42');
      expect(req.actor?.tenantId).toBe('edge-ten-42');
      expect(req.actor?.role).toBe('CUSTOMER');
    });

    it('throws UnauthorizedError when authorization header is missing and no headers present', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      const middleware = createAuthMiddleware(resolver);

      const req = {
        headers: {},
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await expect(middleware(req, reply)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when token is invalid or expired', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      const middleware = createAuthMiddleware(resolver);

      const req = {
        headers: {
          authorization: 'Bearer bad-invalid-token',
        },
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await expect(middleware(req, reply)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('4. Fastify createOptionalAuthMiddleware Integration with Actor Resolvers', () => {
    it('sets request.actor when valid token is present', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      const middleware = createOptionalAuthMiddleware(resolver);

      const req = {
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await middleware(req, reply);
      expect(req.actor).toBeDefined();
      expect(req.actor?.userId).toBe('user-alpha-1');
    });

    it('silently ignores missing or invalid tokens without throwing', async () => {
      const resolver = identityModule.createStatelessResolver(SECRET);
      const middleware = createOptionalAuthMiddleware(resolver);

      const reqNoAuth = { headers: {} } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;
      await middleware(reqNoAuth, reply);
      expect(reqNoAuth.actor).toBeUndefined();

      const reqBadAuth = {
        headers: { authorization: 'Bearer broken' },
      } as unknown as FastifyRequest;
      await middleware(reqBadAuth, reply);
      expect(reqBadAuth.actor).toBeUndefined();
    });
  });
});
