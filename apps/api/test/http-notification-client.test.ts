import { describe, it, expect, vi } from 'vitest';
import {
  HttpNotificationClient,
  HttpNotificationClientError,
  LocalNotificationClient,
  notificationModule,
  type INotificationClient,
  type RequestNotificationInput,
} from '../src/modules/notifications/index.js';
import { ValidationError } from '../src/errors/app-error.js';
import { parseConfig, ConfigurationError } from '../src/config/index.js';

describe('HttpNotificationClient (Monolith Adapter for Standalone Notifications Service)', () => {
  const BASE_URL = 'http://notifications-service.internal:3001';
  const VALID_KEY = 'test-internal-service-secret-key-32chars';

  describe('1. Configuration & Instantiation', () => {
    it('initializes with a valid baseUrl, key, and strips trailing slashes', () => {
      const client = new HttpNotificationClient(`${BASE_URL}///`, VALID_KEY);
      expect(client).toBeInstanceOf(HttpNotificationClient);
    });

    it('initializes with a config object and custom timeout', () => {
      const client = new HttpNotificationClient({
        baseUrl: `${BASE_URL}/`,
        internalServiceKey: VALID_KEY,
        timeoutMs: 8000,
      });
      expect(client).toBeInstanceOf(HttpNotificationClient);
    });

    it('throws ValidationError if baseUrl is empty or invalid', () => {
      expect(() => new HttpNotificationClient('', VALID_KEY)).toThrow(ValidationError);
      expect(() => new HttpNotificationClient('   ', VALID_KEY)).toThrow(ValidationError);
      expect(() => new HttpNotificationClient('not-a-valid-url', VALID_KEY)).toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError if internalServiceKey is missing or shorter than 16 characters', () => {
      expect(() => new HttpNotificationClient(BASE_URL, '')).toThrow(ValidationError);
      expect(() => new HttpNotificationClient(BASE_URL, 'short-key')).toThrow(ValidationError);
    });

    it('throws ValidationError if timeoutMs is not a positive integer', () => {
      expect(
        () =>
          new HttpNotificationClient({
            baseUrl: BASE_URL,
            internalServiceKey: VALID_KEY,
            timeoutMs: -5,
          }),
      ).toThrow(ValidationError);
      expect(
        () =>
          new HttpNotificationClient({
            baseUrl: BASE_URL,
            internalServiceKey: VALID_KEY,
            timeoutMs: 0,
          }),
      ).toThrow(ValidationError);
    });

    it('notificationModule.createHttpClient creates an HttpNotificationClient instance', () => {
      const client = notificationModule.createHttpClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
      });
      expect(client).toBeInstanceOf(HttpNotificationClient);
    });
  });

  describe('2. Interface Conformance (INotificationClient)', () => {
    it('implements INotificationClient contract with all three methods', () => {
      const client: INotificationClient = new HttpNotificationClient(BASE_URL, VALID_KEY);
      expect(typeof client.requestNotification).toBe('function');
      expect(typeof client.sendTransactionalEmail).toBe('function');
      expect(typeof client.processPendingNotifications).toBe('function');
    });
  });

  describe('3. requestNotification (POST /v1/internal/notifications/request)', () => {
    const validRequestInput: RequestNotificationInput = {
      tenantId: 'tenant-100',
      customerId: 'cust-456',
      eventId: 'evt-order-created-999',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'customer@example.com',
      templateId: 'tpl_order_confirmation',
      payload: {
        orderId: 'ord-123',
        totalCents: 4999,
      },
    };

    it('dispatches to /v1/internal/notifications/request with auth header and body', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            notificationId: 'notif-uuid-1',
            status: 'PENDING',
            channel: 'EMAIL',
            recipient: 'customer@example.com',
            idempotencyKey: 'evt-order-created-999:ORDER_CONFIRMATION:customer@example.com:EMAIL',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.requestNotification(validRequestInput);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(`${BASE_URL}/v1/internal/notifications/request`);
      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)?.['X-Internal-Service-Key']).toBe(
        VALID_KEY,
      );
      expect((capturedInit?.headers as Record<string, string>)?.['Content-Type']).toBe(
        'application/json',
      );

      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({
        tenantId: 'tenant-100',
        customerId: 'cust-456',
        eventId: 'evt-order-created-999',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'customer@example.com',
        templateId: 'tpl_order_confirmation',
        payload: {
          orderId: 'ord-123',
          totalCents: 4999,
        },
      });

      expect(result).toEqual({
        notificationId: 'notif-uuid-1',
        status: 'PENDING',
        channel: 'EMAIL',
        recipient: 'customer@example.com',
        idempotencyKey: 'evt-order-created-999:ORDER_CONFIRMATION:customer@example.com:EMAIL',
      });
    });

    it('handles skipped responses correctly', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            notificationId: '',
            status: 'SKIPPED',
            channel: 'EMAIL',
            recipient: 'customer@example.com',
            idempotencyKey: 'evt-1:ORDER_CONFIRMATION:customer@example.com:EMAIL',
            skipped: true,
            reason: 'CUSTOMER_NOTIFICATION_TYPE_DISABLED',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.requestNotification(validRequestInput);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('CUSTOMER_NOTIFICATION_TYPE_DISABLED');
    });

    it('validates input prior to network request', async () => {
      const mockFetch = vi.fn();
      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        client.requestNotification({ ...validRequestInput, tenantId: '' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        client.requestNotification({ ...validRequestInput, recipient: '' }),
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects missing, empty, and whitespace-only event IDs with zero outbound HTTP requests', async () => {
      const mockFetch = vi.fn();
      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      // 1. Missing eventId
      await expect(
        client.requestNotification({ ...validRequestInput, eventId: undefined as any }),
      ).rejects.toThrow(ValidationError);

      // 2. Empty string eventId
      await expect(
        client.requestNotification({ ...validRequestInput, eventId: '' }),
      ).rejects.toThrow(ValidationError);

      // 3. Whitespace-only eventId
      await expect(
        client.requestNotification({ ...validRequestInput, eventId: '   ' }),
      ).rejects.toThrow(ValidationError);

      // 4. Non-string eventId
      await expect(
        client.requestNotification({ ...validRequestInput, eventId: 9876 as any }),
      ).rejects.toThrow(ValidationError);

      // Zero outbound HTTP requests must be made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('preserves valid deterministic eventId and trims surrounding whitespace', async () => {
      let capturedBody: string | undefined;
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            notificationId: 'notif-uuid-trim',
            status: 'PENDING',
            channel: 'EMAIL',
            recipient: 'customer@example.com',
            idempotencyKey: 'evt-order-created-999:ORDER_CONFIRMATION:customer@example.com:EMAIL',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.requestNotification({
        ...validRequestInput,
        eventId: '  evt-order-created-999  ',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.eventId).toBe('evt-order-created-999');
      expect(result.notificationId).toBe('notif-uuid-trim');
    });
  });

  describe('3. sendTransactionalEmail (POST /v1/internal/notifications/transactional-email)', () => {
    it('dispatches to /v1/internal/notifications/transactional-email and translates providerMessageId', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            providerMessageId: 'resend_email_msg_98765',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const messageId = await client.sendTransactionalEmail(
        'alice@example.com',
        'Verify your account',
        'Please click here: https://example.com/verify?token=abc',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(`${BASE_URL}/v1/internal/notifications/transactional-email`);
      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)?.['X-Internal-Service-Key']).toBe(
        VALID_KEY,
      );

      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({
        tenantId: 'default',
        recipient: 'alice@example.com',
        subject: 'Verify your account',
        body: 'Please click here: https://example.com/verify?token=abc',
      });

      expect(messageId).toBe('resend_email_msg_98765');
    });

    it('validates email arguments before dispatching', async () => {
      const mockFetch = vi.fn();
      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.sendTransactionalEmail('not-an-email', 'Subj', 'Body')).rejects.toThrow(
        ValidationError,
      );
      await expect(client.sendTransactionalEmail('test@example.com', '', 'Body')).rejects.toThrow(
        ValidationError,
      );
      await expect(client.sendTransactionalEmail('test@example.com', 'Subj', '')).rejects.toThrow(
        ValidationError,
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('4. processPendingNotifications (POST /v1/internal/notifications/process)', () => {
    it('dispatches to /v1/internal/notifications/process with bounded options', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            claimed: 25,
            sent: 20,
            failed: 5,
            deadLettered: 0,
            processed: 25,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.processPendingNotifications({
        batchSize: 50,
        baseRetryDelayMs: 2000,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(`${BASE_URL}/v1/internal/notifications/process`);
      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)?.['X-Internal-Service-Key']).toBe(
        VALID_KEY,
      );

      const parsedBody = JSON.parse(capturedInit?.body as string);
      expect(parsedBody).toEqual({
        batchSize: 50,
        baseRetryDelayMs: 2000,
      });

      expect(result).toEqual({
        claimed: 25,
        sent: 20,
        failed: 5,
        deadLettered: 0,
      });
    });

    it('works when invoked without options', async () => {
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({
            claimed: 0,
            sent: 0,
            failed: 0,
            deadLettered: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await client.processPendingNotifications();
      expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, deadLettered: 0 });
      expect(JSON.parse(capturedInit?.body as string)).toEqual({});
    });

    it('validates options bounds before dispatching', async () => {
      const mockFetch = vi.fn();
      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.processPendingNotifications({ batchSize: 0 })).rejects.toThrow(
        ValidationError,
      );
      await expect(client.processPendingNotifications({ batchSize: 1000 })).rejects.toThrow(
        ValidationError,
      );
      await expect(client.processPendingNotifications({ baseRetryDelayMs: 50 })).rejects.toThrow(
        ValidationError,
      );
      await expect(
        client.processPendingNotifications({ baseRetryDelayMs: 500000 }),
      ).rejects.toThrow(ValidationError);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('5. Error Handling, Authentication, Timeouts, and Network Failures', () => {
    it('translates HTTP 401 Unauthorized into HttpNotificationClientError with AUTH code', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: 'Unauthorized',
            message: 'Invalid internal service credentials',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        client.sendTransactionalEmail('bob@example.com', 'Subject', 'Body'),
      ).rejects.toThrow(HttpNotificationClientError);

      try {
        await client.sendTransactionalEmail('bob@example.com', 'Subject', 'Body');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpNotificationClientError);
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(401);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_AUTH_ERROR');
      }
    });

    it('translates HTTP 403 Forbidden into HttpNotificationClientError with AUTH code', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('Forbidden', { status: 403 });
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.processPendingNotifications();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpNotificationClientError);
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(403);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_AUTH_ERROR');
      }
    });

    it('translates HTTP 500 Server Error into HttpNotificationClientError', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: 'Internal Server Error',
            message: 'Database connection failed',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.processPendingNotifications();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpNotificationClientError);
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(500);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_HTTP_ERROR');
        expect(clientErr.message).toContain('Database connection failed');
      }
    });

    it('translates network fetch failure into NOTIFICATION_SERVICE_NETWORK_ERROR (502)', async () => {
      const mockFetch = vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.sendTransactionalEmail('test@example.com', 'Subject', 'Body');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpNotificationClientError);
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(502);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_NETWORK_ERROR');
        expect(clientErr.message).toContain('ECONNREFUSED');
      }
    });

    it('translates request timeout into NOTIFICATION_SERVICE_TIMEOUT (504)', async () => {
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        timeoutMs: 10, // 10ms short timeout
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.processPendingNotifications();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpNotificationClientError);
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(504);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_TIMEOUT');
      }
    });

    it('translates malformed JSON responses into NOTIFICATION_SERVICE_MALFORMED_RESPONSE (502)', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('<html>502 Bad Gateway</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.processPendingNotifications()).rejects.toThrow(
        HttpNotificationClientError,
      );

      try {
        await client.processPendingNotifications();
      } catch (err) {
        const clientErr = err as HttpNotificationClientError;
        expect(clientErr.statusCode).toBe(502);
        expect(clientErr.code).toBe('NOTIFICATION_SERVICE_MALFORMED_RESPONSE');
      }
    });

    it('translates missing required fields in success response into MALFORMED_RESPONSE', async () => {
      const mockFetch = vi.fn(async () => {
        // Missing providerMessageId in sendTransactionalEmail
        return new Response(JSON.stringify({ status: 'OK' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        client.sendTransactionalEmail('bob@example.com', 'Subject', 'Body'),
      ).rejects.toThrow(HttpNotificationClientError);
    });

    it('does NOT automatically retry on failure', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'Internal Error' }), { status: 500 });
      });

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        client.sendTransactionalEmail('bob@example.com', 'Subject', 'Body'),
      ).rejects.toThrow(HttpNotificationClientError);

      // Verifies fetch was called exactly 1 time, no blind retries
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('6. Configuration & Feature Flag Validation', () => {
    const baseEnv: Record<string, string> = {
      NODE_ENV: 'test',
      PORT: '3000',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'commerce_test',
      DATABASE_USER: 'test',
      DATABASE_PASSWORD: 'testpassword',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_TLS: 'false',
      ACCESS_TOKEN_SECRET: 'super-secret-key-that-is-at-least-16-characters-long',
      SERVICE_NAME: 'test-commerce-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    };

    it('defaults to local client mode when NOTIFICATION_CLIENT_MODE is omitted', () => {
      const config = parseConfig(baseEnv);
      expect(config.notifications.clientMode).toBe('local');
      expect(config.notifications.serviceUrl).toBeUndefined();
      expect(config.notifications.serviceKey).toBeUndefined();
    });

    it('defaults to local client mode when NOTIFICATION_CLIENT_MODE is empty', () => {
      const config = parseConfig({
        ...baseEnv,
        NOTIFICATION_CLIENT_MODE: '',
      });
      expect(config.notifications.clientMode).toBe('local');
    });

    it('succeeds with http mode when URL and valid key are provided', () => {
      const config = parseConfig({
        ...baseEnv,
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: 'http://notifications-service.internal:3001',
        NOTIFICATION_SERVICE_KEY: 'service-key-min-16-chars-long',
        NOTIFICATION_SERVICE_TIMEOUT_MS: '8000',
      });
      expect(config.notifications.clientMode).toBe('http');
      expect(config.notifications.serviceUrl).toBe('http://notifications-service.internal:3001');
      expect(config.notifications.serviceKey).toBe('service-key-min-16-chars-long');
      expect(config.notifications.timeoutMs).toBe(8000);
    });

    it('fails fast with ConfigurationError when NOTIFICATION_CLIENT_MODE is http but URL is missing', () => {
      expect(() =>
        parseConfig({
          ...baseEnv,
          NOTIFICATION_CLIENT_MODE: 'http',
          NOTIFICATION_SERVICE_KEY: 'service-key-min-16-chars-long',
        }),
      ).toThrow(ConfigurationError);

      try {
        parseConfig({
          ...baseEnv,
          NOTIFICATION_CLIENT_MODE: 'http',
          NOTIFICATION_SERVICE_KEY: 'service-key-min-16-chars-long',
        });
      } catch (err) {
        const cfgErr = err as ConfigurationError;
        expect(cfgErr.issues.some((i) => i.field === 'NOTIFICATION_SERVICE_URL')).toBe(true);
      }
    });

    it('fails fast with ConfigurationError when NOTIFICATION_CLIENT_MODE is http but key is missing or short', () => {
      expect(() =>
        parseConfig({
          ...baseEnv,
          NOTIFICATION_CLIENT_MODE: 'http',
          NOTIFICATION_SERVICE_URL: 'http://notifications-service.internal:3001',
        }),
      ).toThrow(ConfigurationError);

      expect(() =>
        parseConfig({
          ...baseEnv,
          NOTIFICATION_CLIENT_MODE: 'http',
          NOTIFICATION_SERVICE_URL: 'http://notifications-service.internal:3001',
          NOTIFICATION_SERVICE_KEY: 'too-short',
        }),
      ).toThrow(ConfigurationError);
    });

    it('proves default setup retains LocalNotificationClient', () => {
      const dummyService = {
        requestNotification: vi.fn(),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };
      const client = notificationModule.createClient(dummyService as any);
      expect(client).toBeInstanceOf(LocalNotificationClient);
    });
  });

  describe('7. Bounded Response Body Consumption (Task 5 & Finding 6)', () => {
    it('rejects responses with Content-Length header exceeding maxResponseBytes', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"data":"large"}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '100000', // 100 KB
          },
        }),
      );

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch,
        maxResponseBytes: 1024, // 1 KB limit
      });

      const err = await client
        .requestNotification({
          tenantId: 'tenant-1',
          recipient: 'user@example.com',
          channel: 'EMAIL',
          notificationType: 'ORDER_CONFIRMATION',
          templateId: 'tmpl-1',
          eventId: 'evt-1',
          payload: { orderId: 'ord-1' },
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpNotificationClientError);
      expect((err as HttpNotificationClientError).code).toBe(
        'NOTIFICATION_SERVICE_RESPONSE_TOO_LARGE',
      );
      expect((err as HttpNotificationClientError).statusCode).toBe(502);
      expect((err as HttpNotificationClientError).message).toContain(
        'exceeded maximum allowed size',
      );
      expect((err as HttpNotificationClientError).message).not.toContain(VALID_KEY);
    });

    it('rejects chunked / streamed responses exceeding maxResponseBytes and cancels stream', async () => {
      let streamCancelled = false;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"chunks":'));
          controller.enqueue(new TextEncoder().encode('"' + 'x'.repeat(2000) + '"'));
          controller.enqueue(new TextEncoder().encode('}'));
          controller.close();
        },
        cancel() {
          streamCancelled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch,
        maxResponseBytes: 500, // 500 byte limit
      });

      const err = await client
        .sendTransactionalEmail('buyer@example.com', 'Receipt', '<p>Hi</p>')
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpNotificationClientError);
      expect((err as HttpNotificationClientError).code).toBe(
        'NOTIFICATION_SERVICE_RESPONSE_TOO_LARGE',
      );
      expect((err as HttpNotificationClientError).statusCode).toBe(502);
      expect(streamCancelled).toBe(true);
    });

    it('rejects empty response bodies with NOTIFICATION_SERVICE_MALFORMED_RESPONSE', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = new HttpNotificationClient({
        baseUrl: BASE_URL,
        internalServiceKey: VALID_KEY,
        fetchFn: mockFetch,
      });

      const err = await client.processPendingNotifications({ batchSize: 10 }).catch((e) => e);

      expect(err).toBeInstanceOf(HttpNotificationClientError);
      expect((err as HttpNotificationClientError).code).toBe(
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
      expect((err as HttpNotificationClientError).statusCode).toBe(502);
      expect((err as HttpNotificationClientError).message).toContain('empty response');
    });

    it('validates custom maxResponseBytes in constructor', () => {
      expect(
        () =>
          new HttpNotificationClient({
            baseUrl: BASE_URL,
            internalServiceKey: VALID_KEY,
            maxResponseBytes: -1,
          }),
      ).toThrow(ValidationError);

      expect(
        () =>
          new HttpNotificationClient({
            baseUrl: BASE_URL,
            internalServiceKey: VALID_KEY,
            maxResponseBytes: 0,
          }),
      ).toThrow(ValidationError);
    });
  });
});
