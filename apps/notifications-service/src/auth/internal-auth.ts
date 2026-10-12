import { timingSafeEqual } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../errors/app-error.js';

/**
 * Validates a provided service key against the expected secret using constant-time comparison
 * to prevent timing attacks.
 */
export function verifyInternalServiceKey(
  providedKey: string | undefined,
  expectedKey: string,
): boolean {
  if (!providedKey || typeof providedKey !== 'string') {
    return false;
  }
  const providedBuf = Buffer.from(providedKey, 'utf8');
  const expectedBuf = Buffer.from(expectedKey, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Fastify preHandler hook enforcing internal service-to-service authentication.
 *
 * Accepts either:
 * - Header `X-Internal-Service-Key: <key>`
 * - Header `Authorization: Bearer <key>`
 * - Header `Authorization: InternalKey <key>`
 *
 * Never logs raw tokens or authorization headers.
 */
export function createInternalAuthMiddleware(expectedKey: string) {
  if (!expectedKey || expectedKey.length < 16) {
    throw new Error(
      'Internal authentication requires a key with a minimum length of 16 characters',
    );
  }

  return async function authenticateInternalService(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const headerKey = request.headers['x-internal-service-key'];
    let providedKey: string | undefined;

    if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
      providedKey = headerKey.trim();
    } else {
      const authHeader = request.headers.authorization;
      if (typeof authHeader === 'string') {
        if (authHeader.startsWith('Bearer ')) {
          providedKey = authHeader.slice('Bearer '.length).trim();
        } else if (authHeader.startsWith('InternalKey ')) {
          providedKey = authHeader.slice('InternalKey '.length).trim();
        }
      }
    }

    if (!providedKey) {
      throw new UnauthorizedError('Missing internal service credentials');
    }

    const isValid = verifyInternalServiceKey(providedKey, expectedKey);
    if (!isValid) {
      throw new UnauthorizedError('Invalid internal service credentials');
    }
  };
}
