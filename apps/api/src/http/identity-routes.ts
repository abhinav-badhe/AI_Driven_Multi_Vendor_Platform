import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { ValidationError } from '../errors/app-error.js';

export function registerIdentityRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  options?: { rateLimiter?: InMemoryRateLimiter },
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth  = createOptionalAuthMiddleware(identityService);
  const rateLimiter = options?.rateLimiter ?? new InMemoryRateLimiter();
  const rateLimitHook = rateLimiter.middleware();

  // POST /auth/register
  app.post('/auth/register', { preHandler: rateLimitHook }, async (request, reply) => {
    const body = request.body as {
      email?: unknown;
      password?: unknown;
      tenantName?: unknown;
      role?: unknown;
    };

    if (typeof body.email !== 'string') throw new ValidationError('email is required');
    if (typeof body.password !== 'string') throw new ValidationError('password is required');
    if (typeof body.tenantName !== 'string') throw new ValidationError('tenantName is required');
    if (body.role !== 'MERCHANT' && body.role !== 'CUSTOMER') {
      throw new ValidationError('role must be MERCHANT or CUSTOMER');
    }

    const tokens = await identityService.register({
      email: body.email,
      password: body.password,
      tenantName: body.tenantName,
      role: body.role,
    });

    const isProd = process.env.NODE_ENV === 'production';
    const maxAgeSeconds = Math.max(0, Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000));

    reply.setCookie('auth_refresh', tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: maxAgeSeconds,
    });

    return reply.status(201).send({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    });
  });

  // POST /auth/login
  app.post('/auth/login', { preHandler: rateLimitHook }, async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown };

    if (typeof body.email !== 'string') throw new ValidationError('email is required');
    if (typeof body.password !== 'string') throw new ValidationError('password is required');

    const tokens = await identityService.login(
      { email: body.email, password: body.password },
      {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      },
    );

    const isProd = process.env.NODE_ENV === 'production';
    const maxAgeSeconds = Math.max(0, Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000));

    reply.setCookie('auth_refresh', tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: maxAgeSeconds,
    });

    return reply.status(200).send({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    });
  });

  // POST /auth/refresh
  app.post('/auth/refresh', { preHandler: rateLimitHook }, async (request, reply) => {
    const refreshToken = request.cookies['auth_refresh'];
    if (typeof refreshToken !== 'string') {
      throw new ValidationError('Missing refresh token cookie');
    }

    const tokens = await identityService.refresh(refreshToken, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    const isProd = process.env.NODE_ENV === 'production';
    const maxAgeSeconds = Math.max(0, Math.floor((new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / 1000));

    reply.setCookie('auth_refresh', tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: maxAgeSeconds,
    });

    return reply.status(200).send({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    });
  });

  // POST /auth/logout
  // Cookie-authoritative: the access token is optional.
  // Revocation is driven exclusively by the auth_refresh cookie so that an
  // expired access token never prevents refresh-family revocation.
  app.post(
    '/auth/logout',
    { preHandler: optionalAuth },
    async (request, reply) => {
      const refreshToken = request.cookies['auth_refresh'];

      if (typeof refreshToken === 'string') {
        // Revoke via IdentityService – preserves all existing hashing/family/audit semantics.
        // logout() is safe/idempotent: if the token is already revoked or not found it is a no-op.
        await identityService.logout(refreshToken);
      }
      // Always clear the cookie regardless of whether a token was present.
      reply.clearCookie('auth_refresh', { path: '/api/auth' });
      return reply.status(204).send();
    },
  );


  // GET /auth/me
  app.get(
    '/auth/me',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const identity = await identityService.getIdentity(actor.userId);
      if (!identity) {
        return reply.status(404).send({ error: 'Identity not found' });
      }
      return reply.status(200).send({
        userId: identity.userId,
        email: identity.email,
        tenantId: identity.tenantId,
        role: identity.role,
      });
    },
  );
}
