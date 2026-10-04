import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors/app-error.js';

export class TooManyRequestsError extends AppError {
  public readonly statusCode = 429;
  public readonly code = 'TOO_MANY_REQUESTS';
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export class InMemoryRateLimiter {
  private readonly hits = new Map<string, { count: number; expiresAt: number }>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.windowMs = options?.windowMs ?? 60_000; // 1 minute default
    this.maxRequests = options?.maxRequests ?? 20; // 20 requests per window default
  }

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.expiresAt <= now) {
      this.hits.set(key, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  middleware() {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const key = `${request.ip}:${request.url}`;
      const allowed = this.check(key);
      if (!allowed) {
        throw new TooManyRequestsError(
          'Too many requests. Please slow down and try again later.',
        );
      }
    };
  }
}
