import { describe, it, expect, vi } from 'vitest';
import {
  HttpEventTransport,
  HttpOutboxClient,
  InMemoryOutboxStore,
  InMemoryEventTransport,
  createDomainEvent,
  EventTypes,
  type DomainEvent,
  type OutboxEventRecord,
} from '../src/modules/events/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import { NotFoundError, ForbiddenError, ExternalServiceError } from '../src/errors/app-error.js';

const mockAdminActor: AuthorizedActor = {
  userId: 'usr-admin-1',
  tenantId: 'tenant-1',
  role: 'ADMINISTRATOR',
};

const mockEvent: DomainEvent = createDomainEvent({
  eventType: EventTypes.ORDER_CREATED,
  aggregateType: 'order',
  aggregateId: 'ord-123',
  tenantId: 'tenant-1',
  payload: {
    orderId: 'ord-123',
    totalAmount: 500,
  },
  metadata: {
    correlationId: 'corr-123',
  },
});

const mockOutboxRecord: OutboxEventRecord = {
  eventId: mockEvent.eventId,
  eventType: mockEvent.eventType,
  eventVersion: mockEvent.eventVersion,
  aggregateType: mockEvent.aggregateType,
  aggregateId: mockEvent.aggregateId,
  tenantId: mockEvent.tenantId,
  occurredAt: mockEvent.occurredAt,
  payload: mockEvent.payload,
  metadata: (mockEvent.metadata ?? {}) as Record<string, unknown>,
  status: 'PENDING',
  attemptCount: 0,
  availableAt: new Date().toISOString(),
  leaseExpiresAt: null,
  publishedAt: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('HttpEventTransport', () => {
  const baseUrl = 'http://event-broker.internal:4160';

  it('publishes domain event to remote event broker over HTTP', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOptions = opts;
      return new Response(JSON.stringify({ published: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const transport = new HttpEventTransport(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await transport.publish(mockEvent);

    expect(capturedUrl).toBe(`${baseUrl}/events/publish`);
    expect(capturedOptions?.method).toBe('POST');
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-event-id']).toBe(mockEvent.eventId);
    expect(headers['x-event-type']).toBe(mockEvent.eventType);
    expect(headers['x-tenant-id']).toBe(mockEvent.tenantId);

    const body = JSON.parse(capturedOptions?.body as string);
    expect(body.eventId).toBe(mockEvent.eventId);
    expect(body.eventType).toBe(EventTypes.ORDER_CREATED);
  });

  it('throws ExternalServiceError when remote event broker responds with error', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('Broker cluster unavailable', { status: 503 });
    });

    const transport = new HttpEventTransport(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(transport.publish(mockEvent)).rejects.toThrow(ExternalServiceError);
  });

  it('falls back to fallbackTransport when remote transport fails', async () => {
    const fallbackTransport = new InMemoryEventTransport();
    let handled = false;
    fallbackTransport.subscribe(EventTypes.ORDER_CREATED, async (evt) => {
      expect(evt.eventId).toBe(mockEvent.eventId);
      handled = true;
    });

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('Network error', { status: 500 });
    });

    const transport = new HttpEventTransport(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackTransport,
    });

    await transport.publish(mockEvent);
    expect(handled).toBe(true);
  });

  it('manages subscribers and unsubscribers locally', async () => {
    const transport = new HttpEventTransport(baseUrl);
    let count = 0;
    const handler = async () => {
      count++;
    };

    transport.subscribe(EventTypes.ORDER_CREATED, handler);
    transport.unsubscribe(EventTypes.ORDER_CREATED, handler);
    expect(count).toBe(0);
  });
});

describe('HttpOutboxClient', () => {
  const baseUrl = 'http://event-broker.internal:4160';

  it('lists outbox events with filters and propagated auth context', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = opts.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          items: [mockOutboxRecord],
          total: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.listEvents(mockAdminActor, {
      status: 'PENDING',
      tenantId: 'tenant-1',
      limit: 10,
      offset: 0,
    });

    expect(capturedUrl).toContain(
      '/events/outbox?status=PENDING&tenantId=tenant-1&limit=10&offset=0',
    );
    expect(capturedHeaders['x-user-id']).toBe(mockAdminActor.userId);
    expect(capturedHeaders['x-user-role']).toBe(mockAdminActor.role);
    expect(capturedHeaders['x-tenant-id']).toBe(mockAdminActor.tenantId);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('retrieves event by ID', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify(mockOutboxRecord), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.getEventById(mockAdminActor, 'outbox-1');
    expect(result.eventId).toBe(mockEvent.eventId);
  });

  it('triggers replay of outbox event', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ replayed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.replayEvent(mockAdminActor, 'outbox-1');
    expect(capturedUrl).toBe(`${baseUrl}/events/outbox/outbox-1/replay`);
    expect(result.replayed).toBe(true);
  });

  it('processes pending outbox events', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          batchSize: 5,
          publishedCount: 5,
          failedCount: 0,
          deadLetteredCount: 0,
          remainingPendingCount: 0,
          results: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.publishPendingEvents({ batchSize: 10 });
    expect(result.publishedCount).toBe(5);
    expect(result.failedCount).toBe(0);
  });

  it('resets consumer idempotency receipts', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ clearedCount: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.resetConsumerReceipts(mockAdminActor, 'search-consumer');
    expect(result.clearedCount).toBe(3);
  });

  it('maps HTTP 404 to NotFoundError and 403 to ForbiddenError', async () => {
    const mockFetch404 = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ message: 'Event not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client404 = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch404 as unknown as typeof fetch,
    });

    await expect(client404.getEventById(mockAdminActor, 'missing-id')).rejects.toThrow(
      NotFoundError,
    );

    const mockFetch403 = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client403 = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch403 as unknown as typeof fetch,
    });

    await expect(client403.replayEvent(mockAdminActor, 'outbox-1')).rejects.toThrow(ForbiddenError);
  });

  it('falls back to local InMemoryOutboxStore when remote service is unavailable', async () => {
    const inMemoryStore = new InMemoryOutboxStore();
    await inMemoryStore.recordEvent(null, mockEvent);

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('Internal Server Error', { status: 500 });
    });

    const client = new HttpOutboxClient(baseUrl, {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackService: inMemoryStore,
    });

    const result = await client.listEvents(mockAdminActor);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.eventId).toBe(mockEvent.eventId);
  });
});
