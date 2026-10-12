import { AppError, ValidationError } from '../../../errors/app-error.js';
import type { INotificationClient } from './notification-client.js';
import { readBoundedText, DEFAULT_MAX_RESPONSE_BYTES } from './http-event-forwarder.js';
import type {
  RequestNotificationInput,
  NotificationResultDto,
  NotificationChannel,
  NotificationStatus,
} from './notification-models.js';

/**
 * Custom error thrown when HTTP communication, authentication, or response validation
 * with the standalone Notifications Service fails.
 */
export class HttpNotificationClientError extends AppError {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(
    message: string,
    statusCode = 502,
    code = 'NOTIFICATION_SERVICE_HTTP_ERROR',
    details?: unknown,
  ) {
    super(message, details);
    this.name = 'HttpNotificationClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface HttpNotificationClientConfig {
  baseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  maxResponseBytes?: number | undefined;
}

export interface HttpNotificationClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  maxResponseBytes?: number | undefined;
}

/**
 * HTTP adapter implementing INotificationClient for the standalone Notifications microservice.
 *
 * Dispatches requests over HTTP using authenticated internal endpoints:
 * - POST /v1/internal/notifications/request
 * - POST /v1/internal/notifications/transactional-email
 * - POST /v1/internal/notifications/process
 *
 * Invariant: Does NOT silently fall back to local in-process delivery on network or service
 * errors, avoiding duplicated notifications or hidden microservice outages.
 * Invariant: Does NOT log internal service keys, authorization headers, or sensitive payload data.
 */
export class HttpNotificationClient implements INotificationClient {
  private readonly baseUrl: string;
  private readonly internalServiceKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(
    configOrBaseUrl: string | HttpNotificationClientConfig,
    serviceKeyOrOptions?: string | HttpNotificationClientOptions,
    options?: HttpNotificationClientOptions,
  ) {
    if (typeof configOrBaseUrl === 'string') {
      this.baseUrl = configOrBaseUrl.trim().replace(/\/+$/, '');
      this.internalServiceKey =
        typeof serviceKeyOrOptions === 'string' ? serviceKeyOrOptions.trim() : '';
      this.timeoutMs = options?.timeoutMs ?? 5000;
      this.fetchFn = options?.fetchFn ?? globalThis.fetch;
      this.maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    } else {
      this.baseUrl = (configOrBaseUrl.baseUrl || '').trim().replace(/\/+$/, '');
      this.internalServiceKey = (configOrBaseUrl.internalServiceKey || '').trim();
      const opts =
        (typeof serviceKeyOrOptions === 'object' ? serviceKeyOrOptions : undefined) ?? options;
      this.timeoutMs = configOrBaseUrl.timeoutMs ?? opts?.timeoutMs ?? 5000;
      this.fetchFn = configOrBaseUrl.fetchFn ?? opts?.fetchFn ?? globalThis.fetch;
      this.maxResponseBytes =
        configOrBaseUrl.maxResponseBytes ?? opts?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    }

    if (!this.baseUrl) {
      throw new ValidationError(
        'Notifications service baseUrl is required for HttpNotificationClient',
      );
    }
    try {
      new URL(this.baseUrl);
    } catch {
      throw new ValidationError(`Invalid Notifications service baseUrl: '${this.baseUrl}'`);
    }

    if (!this.internalServiceKey || this.internalServiceKey.length < 16) {
      throw new ValidationError(
        'Notifications service internalServiceKey must be at least 16 characters',
      );
    }

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ValidationError('Notifications service timeoutMs must be a positive integer');
    }

    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new ValidationError(
        'Notifications service maxResponseBytes must be a positive integer',
      );
    }
  }

  /**
   * Internal helper executing an authenticated JSON POST request with bounded timeout,
   * safe header handling, and comprehensive error mapping.
   */
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`Notifications service request to ${path} timed out after ${this.timeoutMs}ms`),
      );
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Internal-Service-Key': this.internalServiceKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const isAbortOrTimeout =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));

      if (isAbortOrTimeout) {
        throw new HttpNotificationClientError(
          `Notifications service request to ${path} timed out after ${this.timeoutMs}ms`,
          504,
          'NOTIFICATION_SERVICE_TIMEOUT',
        );
      }

      throw new HttpNotificationClientError(
        `Notifications service network request failed on ${path}: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'NOTIFICATION_SERVICE_NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }

    let responseText = '';
    try {
      responseText = await readBoundedText(
        response,
        this.maxResponseBytes,
        (maxBytes, details) =>
          new HttpNotificationClientError(
            `Notifications service response from ${path} exceeded maximum allowed size of ${maxBytes} bytes${details ? ` (${details})` : ''}`,
            502,
            'NOTIFICATION_SERVICE_RESPONSE_TOO_LARGE',
          ),
      );
    } catch (err: unknown) {
      if (err instanceof HttpNotificationClientError) {
        throw err;
      }
      throw new HttpNotificationClientError(
        `Failed reading response body from ${path}: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'NOTIFICATION_SERVICE_NETWORK_ERROR',
      );
    }

    if (!response.ok) {
      let errorDetail = '';
      if (responseText.trim()) {
        try {
          const json = JSON.parse(responseText) as Record<string, unknown>;
          errorDetail =
            (typeof json.message === 'string' && json.message) ||
            (typeof json.error === 'string' && json.error) ||
            responseText.slice(0, 500);
        } catch {
          errorDetail = responseText.slice(0, 500);
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new HttpNotificationClientError(
          `Notifications service authentication failed (HTTP ${response.status}): ${errorDetail || 'Unauthorized or forbidden'}`,
          response.status,
          'NOTIFICATION_SERVICE_AUTH_ERROR',
        );
      }

      throw new HttpNotificationClientError(
        `Notifications service responded with HTTP ${response.status}: ${errorDetail || response.statusText}`,
        response.status,
        'NOTIFICATION_SERVICE_HTTP_ERROR',
      );
    }

    if (!responseText.trim()) {
      throw new HttpNotificationClientError(
        `Notifications service returned empty response from ${path}`,
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseText);
    } catch (err: unknown) {
      throw new HttpNotificationClientError(
        `Notifications service returned malformed JSON response from ${path}: ${err instanceof Error ? err.message : String(err)}`,
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new HttpNotificationClientError(
        `Notifications service returned unexpected non-object JSON response from ${path}`,
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    return parsedJson as T;
  }

  /**
   * Enqueue an asynchronous notification request to the standalone Notifications Service.
   * Maps to POST /v1/internal/notifications/request.
   */
  async requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto> {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('Notification request input is required and must be an object');
    }
    if (!input.tenantId || typeof input.tenantId !== 'string') {
      throw new ValidationError('tenantId is required');
    }
    if (!input.eventId || typeof input.eventId !== 'string' || !input.eventId.trim()) {
      throw new ValidationError('eventId is required and must be a non-empty string');
    }
    if (!input.notificationType || typeof input.notificationType !== 'string') {
      throw new ValidationError('notificationType is required');
    }
    if (!input.channel || typeof input.channel !== 'string') {
      throw new ValidationError('channel is required');
    }
    if (!input.recipient || typeof input.recipient !== 'string') {
      throw new ValidationError('recipient is required');
    }
    if (!input.payload || typeof input.payload !== 'object') {
      throw new ValidationError('payload is required and must be an object');
    }

    const requestBody = {
      tenantId: input.tenantId,
      eventId: input.eventId.trim(),
      notificationType: input.notificationType,
      channel: input.channel,
      recipient: input.recipient,
      templateId: input.templateId,
      payload: input.payload,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    };

    const res = await this.postJson<Record<string, unknown>>(
      '/v1/internal/notifications/request',
      requestBody,
    );

    if (
      typeof res.notificationId !== 'string' ||
      typeof res.status !== 'string' ||
      typeof res.channel !== 'string' ||
      typeof res.recipient !== 'string' ||
      typeof res.idempotencyKey !== 'string'
    ) {
      throw new HttpNotificationClientError(
        'Notifications service returned malformed requestNotification response: missing required fields',
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    return {
      notificationId: res.notificationId,
      status: res.status as NotificationStatus,
      channel: res.channel as NotificationChannel,
      recipient: res.recipient,
      idempotencyKey: res.idempotencyKey,
      ...(typeof res.skipped === 'boolean' ? { skipped: res.skipped } : {}),
      ...(typeof res.reason === 'string' ? { reason: res.reason } : {}),
    };
  }

  /**
   * Immediate synchronous delivery of security/account emails (verification, reset).
   * Maps to POST /v1/internal/notifications/transactional-email.
   *
   * Translates response { providerMessageId: string } into existing string contract.
   */
  async sendTransactionalEmail(to: string, subject: string, body: string): Promise<string> {
    if (!to || typeof to !== 'string' || !to.includes('@')) {
      throw new ValidationError('Valid recipient email address is required');
    }
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new ValidationError('Email subject is required');
    }
    if (!body || typeof body !== 'string' || !body.trim()) {
      throw new ValidationError('Email body is required');
    }

    const requestBody = {
      tenantId: 'default',
      recipient: to.trim(),
      subject: subject.trim(),
      body: body.trim(),
    };

    const res = await this.postJson<Record<string, unknown>>(
      '/v1/internal/notifications/transactional-email',
      requestBody,
    );

    if (typeof res.providerMessageId !== 'string' || !res.providerMessageId.trim()) {
      throw new HttpNotificationClientError(
        'Notifications service returned malformed sendTransactionalEmail response: missing providerMessageId',
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    return res.providerMessageId;
  }

  /**
   * Batch process and dispatch pending notifications to external channels.
   * Maps to POST /v1/internal/notifications/process.
   */
  async processPendingNotifications(options?: {
    batchSize?: number;
    baseRetryDelayMs?: number;
  }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }> {
    const requestBody: Record<string, unknown> = {};
    if (options?.batchSize !== undefined) {
      if (
        typeof options.batchSize !== 'number' ||
        !Number.isInteger(options.batchSize) ||
        options.batchSize < 1 ||
        options.batchSize > 500
      ) {
        throw new ValidationError('batchSize must be an integer between 1 and 500');
      }
      requestBody.batchSize = options.batchSize;
    }

    if (options?.baseRetryDelayMs !== undefined) {
      if (
        typeof options.baseRetryDelayMs !== 'number' ||
        !Number.isInteger(options.baseRetryDelayMs) ||
        options.baseRetryDelayMs < 100 ||
        options.baseRetryDelayMs > 300000
      ) {
        throw new ValidationError('baseRetryDelayMs must be an integer between 100 and 300000');
      }
      requestBody.baseRetryDelayMs = options.baseRetryDelayMs;
    }

    const res = await this.postJson<Record<string, unknown>>(
      '/v1/internal/notifications/process',
      requestBody,
    );

    if (
      typeof res.claimed !== 'number' ||
      typeof res.sent !== 'number' ||
      typeof res.failed !== 'number' ||
      typeof res.deadLettered !== 'number'
    ) {
      throw new HttpNotificationClientError(
        'Notifications service returned malformed processPendingNotifications response: missing stats numbers',
        502,
        'NOTIFICATION_SERVICE_MALFORMED_RESPONSE',
      );
    }

    return {
      claimed: res.claimed,
      sent: res.sent,
      failed: res.failed,
      deadLettered: res.deadLettered,
    };
  }
}
