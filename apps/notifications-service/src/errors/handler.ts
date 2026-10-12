import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './app-error.js';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  };
}

export function errorHandler(
  error: FastifyError | Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    const body: ErrorResponseBody = {
      error: {
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
    reply.status(error.statusCode).send(body);
    return;
  }

  // Handle Fastify schema validation errors
  if ('validation' in error && error.validation) {
    const body: ErrorResponseBody = {
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
        statusCode: 400,
        details: error.validation,
      },
    };
    reply.status(400).send(body);
    return;
  }

  // Handle client 4xx errors from Fastify parser
  if (
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    const body: ErrorResponseBody = {
      error: {
        code: (error.code as string) || 'CLIENT_ERROR',
        message: error.message,
        statusCode: error.statusCode,
      },
    };
    reply.status(error.statusCode).send(body);
    return;
  }

  reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
      statusCode: 500,
    },
  });
}
