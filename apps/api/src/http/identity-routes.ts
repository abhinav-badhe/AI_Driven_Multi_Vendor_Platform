import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import { createAuthMiddleware, createOptionalAuthMiddleware, requireActor } from './auth-middleware.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { ValidationError } from '../errors/app-error.js';

export function registerIdentityRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  options?: {
    rateLimiter?: InMemoryRateLimiter;
    verification?: {
      frontendUrl: string;
      sendEmail: (to: string, subject: string, body: string) => Promise<unknown>;
    } | undefined;
  },
): void {
  const authenticate = createAuthMiddleware(identityService);
  const optionalAuth  = createOptionalAuthMiddleware(identityService);
  const rateLimiter = options?.rateLimiter ?? new InMemoryRateLimiter();
  const rateLimitHook = rateLimiter.middleware();

  const sendVerificationEmail = async (to: string, rawToken: string): Promise<void> => {
    const sender = options?.verification;
    if (!sender) return;
    const url = `${sender.frontendUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(rawToken)}`;
    await sender.sendEmail(
      to,
      'Verify your email address',
      [
        'Welcome! Confirm this email address to activate your account.',
        '',
        `Verify here: ${url}`,
        '',
        'This link expires in 24 hours. If you did not create this account, ignore this email.',
      ].join('\n'),
    );
  };

  // POST /auth/register — creates an UNVERIFIED account and emails a
  // verification link. No session is issued until the email is verified.
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

    const account = await identityService.register({
      email: body.email,
      password: body.password,
      tenantName: body.tenantName,
      role: body.role,
    });

    try {
      const rawToken = await identityService.createEmailVerificationToken(account.userId);
      await sendVerificationEmail(account.email, rawToken);
    } catch {
      // Account exists; the link can be re-requested via resend.
    }

    return reply.status(201).send({
      userId: account.userId,
      email: account.email,
      requiresVerification: true,
    });
  });

  // POST /auth/verify-email — consumes a verification token.
  app.post('/auth/verify-email', { preHandler: rateLimitHook }, async (request, reply) => {
    const body = (request.body as { token?: unknown } | undefined) ?? {};
    if (typeof body.token !== 'string' || body.token.trim() === '') {
      throw new ValidationError('token is required');
    }
    const result = await identityService.verifyEmail(body.token);
    return reply.status(200).send({ userId: result.userId, email: result.email, verified: true });
  });

  // POST /auth/resend-verification — re-sends the link. Always 200 to avoid
  // revealing whether an address is registered or already verified.
  app.post('/auth/resend-verification', { preHandler: rateLimitHook }, async (request, reply) => {
    const body = (request.body as { email?: unknown } | undefined) ?? {};
    if (typeof body.email !== 'string' || !body.email.includes('@')) {
      throw new ValidationError('email is required');
    }
    const pending = await identityService.beginEmailVerification(body.email);
    if (pending) {
      try {
        await sendVerificationEmail(pending.email, pending.rawToken);
      } catch {
        // Token exists; delivery will be retried on the next resend.
      }
    }
    return reply.status(200).send({
      message: 'If an unverified account exists for this email, a new link is on its way.',
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
