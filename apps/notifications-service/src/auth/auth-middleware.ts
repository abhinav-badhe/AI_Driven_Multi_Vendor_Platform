import { FastifyReply, FastifyRequest } from 'fastify';
import { ITokenVerifier, VerifiedActor } from './token-verifier.js';
import { UnauthorizedError, ForbiddenError } from '../errors/app-error.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: VerifiedActor;
  }
}

export function createAuthMiddleware(tokenVerifier: ITokenVerifier) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedError('Missing bearer token');
    }

    const actor = await tokenVerifier.verifyToken(token);
    if (!actor) {
      throw new UnauthorizedError('Invalid or expired authentication token');
    }

    request.actor = actor;
  };
}

export function requireRoles(...allowedRoles: string[]) {
  return async function checkRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.actor) {
      throw new UnauthorizedError('Authentication required');
    }
    if (!allowedRoles.includes(request.actor.role)) {
      throw new ForbiddenError(`Access denied: required role ${allowedRoles.join(' or ')}`);
    }
  };
}
