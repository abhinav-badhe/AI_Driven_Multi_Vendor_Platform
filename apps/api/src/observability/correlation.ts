import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export function getOrGenerateCorrelationId(req: FastifyRequest): string {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  if (typeof incoming === 'string' && incoming.trim().length > 0) {
    return incoming.trim();
  }
  return randomUUID();
}

export function generateRequestId(): string {
  return randomUUID();
}

export function attachCorrelationHeaders(
  reply: FastifyReply,
  correlationId: string,
  requestId: string,
): void {
  reply.header(CORRELATION_ID_HEADER, correlationId);
  reply.header(REQUEST_ID_HEADER, requestId);
}
