import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './app-error.js';
import type { Logger } from '../observability/logger.js';
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from '../observability/correlation.js';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    statusCode: number;
    correlationId: string;
    requestId: string;
    details?: unknown;
  };
}

export function createErrorHandler(logger: Logger) {
  return function fastifyErrorHandler(
    error: FastifyError | Error,
    _request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const correlationId = (reply.getHeader(CORRELATION_ID_HEADER) as string) || 'unknown';
    const requestId = (reply.getHeader(REQUEST_ID_HEADER) as string) || 'unknown';

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        logger.error(`Application internal error: ${error.message}`, {
          correlationId,
          requestId,
          code: error.code,
          stack: error.stack,
          details: error.details,
        });
      } else {
        logger.warn(`Application client error: ${error.message}`, {
          correlationId,
          requestId,
          code: error.code,
          statusCode: error.statusCode,
        });
      }

      const body: ErrorResponseBody = {
        error: {
          code: error.code,
          message: error.message,
          statusCode: error.statusCode,
          correlationId,
          requestId,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };

      reply.status(error.statusCode).send(body);
      return;
    }

    // Handle Fastify schema validation errors
    if ('validation' in error && error.validation) {
      logger.warn(`Request validation failed: ${error.message}`, {
        correlationId,
        requestId,
        validation: error.validation,
      });

      const body: ErrorResponseBody = {
        error: {
          code: 'VALIDATION_FAILED',
          message: error.message,
          statusCode: 400,
          correlationId,
          requestId,
          details: error.validation,
        },
      };

      reply.status(400).send(body);
      return;
    }

    // Unhandled / Unexpected 500 errors - sanitize completely
    logger.error(`Unhandled system error: ${error.message}`, {
      correlationId,
      requestId,
      stack: error.stack,
      rawError: error.name,
    });

    const body: ErrorResponseBody = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred.',
        statusCode: 500,
        correlationId,
        requestId,
      },
    };

    reply.status(500).send(body);
  };
}
