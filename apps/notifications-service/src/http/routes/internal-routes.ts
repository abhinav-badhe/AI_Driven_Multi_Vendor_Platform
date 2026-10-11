import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NotificationService } from '../../domain/notification-service.js';
import { ValidationError } from '../../errors/app-error.js';
import { NotificationChannel, NotificationType } from '../../domain/models.js';
import { NotificationEventConsumer } from '../../events/notification-event-consumer.js';
import {
  DomainEvent,
  EventMetadata,
  isEventVersionSupported,
  inspectForSensitiveKeys,
} from '../../events/event-models.js';

export type InternalAuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function validateDomainEvent(body: unknown): DomainEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be an object');
  }

  const b = body as Record<string, unknown>;

  if (!b.eventId || typeof b.eventId !== 'string' || b.eventId.trim() === '') {
    throw new ValidationError('eventId is required and must be a non-empty string');
  }

  if (!b.eventType || typeof b.eventType !== 'string' || b.eventType.trim() === '') {
    throw new ValidationError('eventType is required and must be a non-empty string');
  }

  if (
    b.eventVersion === undefined ||
    typeof b.eventVersion !== 'number' ||
    !Number.isInteger(b.eventVersion) ||
    b.eventVersion < 1
  ) {
    throw new ValidationError('eventVersion is required and must be a positive integer');
  }

  const eventType = b.eventType.trim();
  const eventVersion = b.eventVersion;

  if (!isEventVersionSupported(eventType, eventVersion)) {
    throw new ValidationError(`Unsupported event version ${eventVersion} for event type '${eventType}'`);
  }

  if (!b.aggregateType || typeof b.aggregateType !== 'string' || b.aggregateType.trim() === '') {
    throw new ValidationError('aggregateType is required and must be a non-empty string');
  }

  if (!b.aggregateId || typeof b.aggregateId !== 'string' || b.aggregateId.trim() === '') {
    throw new ValidationError('aggregateId is required and must be a non-empty string');
  }

  if (!b.tenantId || typeof b.tenantId !== 'string' || b.tenantId.trim() === '') {
    throw new ValidationError('tenantId is required and must be a non-empty string');
  }

  if (!b.occurredAt || typeof b.occurredAt !== 'string' || b.occurredAt.trim() === '') {
    throw new ValidationError('occurredAt is required and must be an ISO date string');
  }

  if (isNaN(Date.parse(b.occurredAt))) {
    throw new ValidationError('occurredAt must be a valid ISO date string');
  }

  if (b.payload === undefined || b.payload === null || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    throw new ValidationError('payload is required and must be a non-null object');
  }

  // Canonical security scan for sensitive keys / credential leaks in payload
  inspectForSensitiveKeys(b.payload);

  if (b.metadata === undefined || b.metadata === null || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) {
    throw new ValidationError('metadata is required and must be an object');
  }

  const m = b.metadata as Record<string, unknown>;
  if (m.correlationId !== undefined && typeof m.correlationId !== 'string') {
    throw new ValidationError('metadata.correlationId must be a string if provided');
  }
  if (m.causationId !== undefined && typeof m.causationId !== 'string') {
    throw new ValidationError('metadata.causationId must be a string if provided');
  }
  if (m.actorId !== undefined && typeof m.actorId !== 'string') {
    throw new ValidationError('metadata.actorId must be a string if provided');
  }
  if (m.source !== undefined && typeof m.source !== 'string') {
    throw new ValidationError('metadata.source must be a string if provided');
  }

  const metadata: EventMetadata = {
    ...m,
    ...(typeof m.correlationId === 'string' ? { correlationId: m.correlationId } : {}),
    ...(typeof m.causationId === 'string' ? { causationId: m.causationId } : {}),
    ...(typeof m.actorId === 'string' ? { actorId: m.actorId } : {}),
    ...(typeof m.source === 'string' ? { source: m.source } : {}),
  };

  return {
    eventId: b.eventId.trim(),
    eventType,
    eventVersion,
    aggregateType: b.aggregateType.trim(),
    aggregateId: b.aggregateId.trim(),
    tenantId: b.tenantId.trim(),
    occurredAt: b.occurredAt.trim(),
    payload: b.payload as Record<string, unknown>,
    metadata,
  };
}

export function registerInternalRoutes(
  app: FastifyInstance,
  notificationService: NotificationService,
  internalAuth: InternalAuthHook,
  eventConsumer?: NotificationEventConsumer,
) {
  const preHandler = [internalAuth];

  // POST /v1/internal/events/ingest
  app.post('/v1/internal/events/ingest', { preHandler }, async (request, reply) => {
    if (!eventConsumer) {
      throw new Error('Notification event consumer is not configured on this instance');
    }

    const event = validateDomainEvent(request.body);

    const result = await eventConsumer.process(event);

    switch (result.status) {
      case 'PROCESSED':
        return reply.status(200).send({
          status: 'PROCESSED',
          eventId: result.eventId,
          handled: true,
          duplicate: false,
        });

      case 'ALREADY_COMPLETED':
        return reply.status(200).send({
          status: 'ALREADY_COMPLETED',
          eventId: result.eventId,
          handled: false,
          duplicate: true,
        });

      case 'CURRENTLY_PROCESSING':
        return reply.status(409).send({
          status: 'CURRENTLY_PROCESSING',
          eventId: result.eventId,
          handled: false,
          duplicate: true,
          error: 'Event is currently being processed by another worker',
        });

      case 'FAILED':
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: result.error,
            statusCode: 500,
          },
          status: 'FAILED',
          eventId: result.eventId,
        });
    }
  });

  // POST /v1/internal/notifications/request
  app.post('/v1/internal/notifications/request', { preHandler }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    if (!body.tenantId || typeof body.tenantId !== 'string') {
      throw new ValidationError('tenantId is required');
    }
    if (!body.eventId || typeof body.eventId !== 'string' || body.eventId.trim() === '') {
      throw new ValidationError('eventId is required and must be a non-empty string');
    }
    if (!body.notificationType || typeof body.notificationType !== 'string') {
      throw new ValidationError('notificationType is required');
    }
    if (!body.channel || typeof body.channel !== 'string') {
      throw new ValidationError('channel is required');
    }
    if (!body.recipient || typeof body.recipient !== 'string') {
      throw new ValidationError('recipient is required');
    }
    if (!body.payload || typeof body.payload !== 'object') {
      throw new ValidationError('payload is required and must be an object');
    }

    const result = await notificationService.requestNotification({
      tenantId: body.tenantId,
      eventId: body.eventId.trim(),
      notificationType: body.notificationType as NotificationType,
      channel: body.channel as NotificationChannel,
      recipient: body.recipient,
      payload: body.payload as Record<string, unknown>,
      ...(typeof body.customerId === 'string' ? { customerId: body.customerId } : {}),
      ...(typeof body.templateId === 'string' ? { templateId: body.templateId } : {}),
      ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
    });

    return reply.status(200).send(result);
  });

  // POST /v1/internal/notifications/transactional-email
  app.post('/v1/internal/notifications/transactional-email', { preHandler }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    if (!body.recipient || typeof body.recipient !== 'string') {
      throw new ValidationError('recipient is required');
    }
    if (!body.subject || typeof body.subject !== 'string') {
      throw new ValidationError('subject is required');
    }
    if (!body.body || typeof body.body !== 'string') {
      throw new ValidationError('body is required');
    }

    const result = await notificationService.sendTransactionalEmail({
      tenantId: typeof body.tenantId === 'string' ? body.tenantId : 'default',
      recipient: body.recipient,
      subject: body.subject,
      body: body.body,
      ...(body.metadata && typeof body.metadata === 'object'
        ? { metadata: body.metadata as Record<string, unknown> }
        : {}),
    });

    return reply.status(200).send(result);
  });

  // POST /v1/internal/notifications/process
  app.post('/v1/internal/notifications/process', { preHandler }, async (request, reply) => {
    let batchSize: number | undefined;
    let baseRetryDelayMs: number | undefined;

    if (request.body !== undefined && request.body !== null) {
      if (typeof request.body !== 'object' || Array.isArray(request.body)) {
        throw new ValidationError('Request body must be an object if provided');
      }

      const body = request.body as Record<string, unknown>;

      if (body.batchSize !== undefined) {
        if (
          typeof body.batchSize !== 'number' ||
          !Number.isInteger(body.batchSize) ||
          body.batchSize < 1 ||
          body.batchSize > 500
        ) {
          throw new ValidationError('batchSize must be an integer between 1 and 500');
        }
        batchSize = body.batchSize;
      }

      if (body.baseRetryDelayMs !== undefined) {
        if (
          typeof body.baseRetryDelayMs !== 'number' ||
          !Number.isInteger(body.baseRetryDelayMs) ||
          body.baseRetryDelayMs < 100 ||
          body.baseRetryDelayMs > 300000
        ) {
          throw new ValidationError('baseRetryDelayMs must be an integer between 100 and 300000');
        }
        baseRetryDelayMs = body.baseRetryDelayMs;
      }
    }

    const processOptions: { batchSize?: number; baseRetryDelayMs?: number } = {};
    if (batchSize !== undefined) {
      processOptions.batchSize = batchSize;
    }
    if (baseRetryDelayMs !== undefined) {
      processOptions.baseRetryDelayMs = baseRetryDelayMs;
    }

    const result = await notificationService.processPendingNotifications(processOptions);

    return reply.status(200).send(result);
  });
}
