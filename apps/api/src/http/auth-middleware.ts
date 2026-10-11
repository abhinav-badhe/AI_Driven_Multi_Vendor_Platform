import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '../errors/app-error.js';
import type { AuthorizedActor, IIdentityActorResolver } from '../modules/identity/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthorizedActor;
  }
}

export function createAuthMiddleware(actorResolver: IIdentityActorResolver) {
  return async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    // 1. Check if trusted gateway headers are present
    if (typeof actorResolver.resolveFromHeaders === 'function') {
      const headerActor = actorResolver.resolveFromHeaders(request.headers);
      if (headerActor) {
        request.actor = headerActor;
        return;
      }
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.slice(7);
    const actor = await actorResolver.resolveActiveActor(token);
    if (!actor) {
      throw new UnauthorizedError('Invalid or expired access token');
    }

    request.actor = actor;
  };
}

export function createOptionalAuthMiddleware(actorResolver: IIdentityActorResolver) {
  return async function optionalAuthenticate(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (typeof actorResolver.resolveFromHeaders === 'function') {
      const headerActor = actorResolver.resolveFromHeaders(request.headers);
      if (headerActor) {
        request.actor = headerActor;
        return;
      }
    }

    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const actor = await actorResolver.resolveActiveActor(token);
        if (actor) {
          request.actor = actor;
        }
      } catch {
        // Deliberately swallow: expired, invalid, or deactivated-user tokens must not
        // abort a cookie-authoritative logout. The route handler relies solely on the
        // auth_refresh cookie for revocation.
      }
    }
  };
}

export function requireActor(request: FastifyRequest): AuthorizedActor {
  if (!request.actor) {
    throw new UnauthorizedError('Authentication required');
  }
  return request.actor;
}
