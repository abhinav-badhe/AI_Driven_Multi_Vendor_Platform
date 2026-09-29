import { describe, it, expect } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  InternalError,
} from '../src/errors/index.js';

describe('Application Error Taxonomy', () => {
  it('correctly sets HTTP status codes and error codes', () => {
    const notFound = new NotFoundError('Item not found');
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe('RESOURCE_NOT_FOUND');
    expect(notFound.message).toBe('Item not found');

    const validation = new ValidationError('Invalid input', { field: 'email' });
    expect(validation.statusCode).toBe(400);
    expect(validation.code).toBe('VALIDATION_FAILED');
    expect(validation.details).toEqual({ field: 'email' });

    const unauthorized = new UnauthorizedError('Unauthorized');
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.code).toBe('UNAUTHORIZED');

    const forbidden = new ForbiddenError('Forbidden');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.code).toBe('FORBIDDEN');

    const conflict = new ConflictError('Conflict occurred');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.code).toBe('RESOURCE_CONFLICT');

    const internal = new InternalError('Database crashed');
    expect(internal.statusCode).toBe(500);
    expect(internal.code).toBe('INTERNAL_ERROR');
  });
});
