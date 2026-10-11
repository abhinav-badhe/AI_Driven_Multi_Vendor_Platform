# Notifications HTTP Adapter Results

## 1. Executive Summary

As part of the phased migration of the monolithic modular commerce platform into independently deployable microservices, this phase implemented the monolith-side HTTP adapter (`HttpNotificationClient`) targeting the standalone Notifications Service (`apps/notifications-service`).

The implementation adheres to the following principles:
- **Adapter-Only Implementation**: Implements the preexisting `INotificationClient` abstraction without changing caller signatures or business contracts.
- **Strict Default Preservation**: `LocalNotificationClient` remains the active, default runtime in development, testing, and production. The HTTP adapter is gated behind explicit configuration (`NOTIFICATION_CLIENT_MODE=http`).
- **Isolation & Safety**: No live HTTP requests were dispatched to any running service; tests run in complete isolation with mocked HTTP transport. No silent fallback to local execution on failure (preventing duplicate sends and hidden outages).
- **Zero Modifications to Extracted Service**: `apps/notifications-service/` and database structures were untouched during this phase.

---

## 2. Files Changed

| File Path | Action | Description |
|---|---|---|
| `apps/api/src/modules/notifications/internal/http-notification-client.ts` | Created | HTTP adapter implementing `INotificationClient`, encapsulating authenticated internal calls, timeout control, input validation, response verification, and typed error handling. |
| `apps/api/src/modules/notifications/index.ts` | Modified | Exported `HttpNotificationClient`, `HttpNotificationClientError`, config types, and factory helper `createHttpClient` on `notificationModule`. |
| `apps/api/src/config/schema.ts` | Modified | Added `NOTIFICATION_CLIENT_MODE` (defaults to `'local'`), `NOTIFICATION_SERVICE_URL`, `NOTIFICATION_SERVICE_KEY`, and `NOTIFICATION_SERVICE_TIMEOUT_MS` (defaults to 5000ms), with Zod `.superRefine` ensuring URL and 16+ char secret key are provided when HTTP mode is active. |
| `apps/api/src/config/index.ts` | Modified | Mapped notification client settings into `AppConfig.notifications`. |
| `apps/api/src/app.ts` | Modified | Minimal dependency injection wiring: instantiates `HttpNotificationClient` when `clientMode === 'http'`, otherwise instantiates `LocalNotificationClient` by default. |
| `apps/api/test/http-notification-client.test.ts` | Created | 29 isolated unit tests covering all 3 endpoints, authentication, response mapping, timeout, network error translation, malformed payloads, retry absence, and configuration validation. |
| `docs/NOTIFICATIONS-HTTP-ADAPTER-RESULTS.md` | Created | This architectural documentation and verification deliverable. |

---

## 3. Implementation of `INotificationClient` Methods

The adapter implements all three methods of `INotificationClient` conforming to the exact signatures and response types:

### A. `requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto>`
- **Endpoint**: `POST /v1/internal/notifications/request`
- **Request Headers**:
  - `Content-Type: application/json`
  - `Accept: application/json`
  - `X-Internal-Service-Key: <internalServiceKey>`
- **Payload**:
  ```json
  {
    "tenantId": "string",
    "notificationType": "string",
    "channel": "string",
    "recipient": "string",
    "templateId": "string",
    "payload": {},
    "customerId": "optional-string",
    "eventId": "optional-string"
  }
  ```
- **Response Validation**: Validates that the response object contains `notificationId`, `status`, `channel`, `recipient`, and `idempotencyKey` as strings.
- **Return Type**: `NotificationResultDto` (including optional `skipped` flag and `reason`).

### B. `sendTransactionalEmail(to: string, subject: string, body: string): Promise<string>`
- **Endpoint**: `POST /v1/internal/notifications/transactional-email`
- **Request Headers**: Same authenticated headers.
- **Payload**:
  ```json
  {
    "tenantId": "default",
    "recipient": "to",
    "subject": "subject",
    "body": "body"
  }
  ```
- **Response Translation**: The standalone service returns `{ "providerMessageId": "..." }`. The adapter verifies `providerMessageId` is a non-empty string and extracts it to satisfy the existing `Promise<string>` contract expected by Identity/Auth and customer services.

### C. `processPendingNotifications(options?: { batchSize?: number; baseRetryDelayMs?: number }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }>`
- **Endpoint**: `POST /v1/internal/notifications/process`
- **Request Headers**: Same authenticated headers.
- **Payload**:
  ```json
  {
    "batchSize": 50,
    "baseRetryDelayMs": 2000
  }
  ```
  (Or `{}` if called without options).
- **Bounds Checking**: Validates `batchSize` (1 to 500) and `baseRetryDelayMs` (100 to 300,000ms) prior to network dispatch.
- **Response Validation**: Asserts that `claimed`, `sent`, `failed`, and `deadLettered` are present as numbers, mapping the JSON response into the interface's return summary.

---

## 4. Configuration and Feature-Flag Behavior

Configuration is integrated directly into the monolith's standard Zod-based config system (`apps/api/src/config/`):

1. **Environment Variables**:
   - `NOTIFICATION_CLIENT_MODE`: `'local' | 'http'` (defaults to `'local'`).
   - `NOTIFICATION_SERVICE_URL`: Base URL string (e.g. `http://notifications-service.internal:3001`).
   - `NOTIFICATION_SERVICE_KEY`: Service-to-service shared secret string (minimum 16 characters).
   - `NOTIFICATION_SERVICE_TIMEOUT_MS`: Request timeout in milliseconds (defaults to 5000ms).

2. **Validation Rules**:
   - When `NOTIFICATION_CLIENT_MODE` is `'local'` (or omitted / empty), `NOTIFICATION_SERVICE_URL` and `NOTIFICATION_SERVICE_KEY` are optional and ignored.
   - When `NOTIFICATION_CLIENT_MODE` is explicitly `'http'`, Zod `.superRefine` enforces that `NOTIFICATION_SERVICE_URL` is a valid URL and `NOTIFICATION_SERVICE_KEY` is present and at least 16 characters long. If either is missing, `parseConfig` throws `ConfigurationError` immediately at startup.

3. **Dependency Injection**:
   In `apps/api/src/app.ts`:
   ```typescript
   const notificationClient: INotificationClient | null =
     config.notifications.clientMode === 'http' &&
     config.notifications.serviceUrl &&
     config.notifications.serviceKey
       ? notificationModule.createHttpClient({
           baseUrl: config.notifications.serviceUrl,
           internalServiceKey: config.notifications.serviceKey,
           timeoutMs: config.notifications.timeoutMs,
         })
       : notificationService
         ? notificationModule.createClient(notificationService)
         : null;
   ```
   If `clientMode !== 'http'`, `LocalNotificationClient` is instantiated, completely preserving the preexisting monolith runtime.

---

## 5. Error Handling, Timeout, Retry, and Fallback Semantics

- **Typed Error**: `HttpNotificationClientError` extends `AppError` and provides structured `.statusCode` and `.code` properties.
- **HTTP 401 / 403 Responses**: Translated to `statusCode: 401/403` with code `NOTIFICATION_SERVICE_AUTH_ERROR`.
- **Other Non-Success HTTP Responses (4xx, 5xx)**: Translated to `statusCode: response.status` with code `NOTIFICATION_SERVICE_HTTP_ERROR`. Error messages are capped to 500 characters to prevent log pollution from large HTML error pages.
- **Network Failures**: Captured `TypeError` or socket drops are mapped to `statusCode: 502`, code `NOTIFICATION_SERVICE_NETWORK_ERROR`.
- **Request Timeouts**: Enforced via `AbortController` and `setTimeout`. Aborted requests are mapped to `statusCode: 504`, code `NOTIFICATION_SERVICE_TIMEOUT`.
- **Malformed / Incomplete Responses**: Non-JSON bodies, non-object JSON bodies, or payloads missing required DTO properties are mapped to `statusCode: 502`, code `NOTIFICATION_SERVICE_MALFORMED_RESPONSE`.
- **No Automatic Retry**: Requests are executed exactly once. POST operations are not retried automatically on failure, avoiding duplicate email/notification dispatch.
- **No Silent Fallback**: The adapter deliberately does **not** fall back to local in-process delivery on HTTP failure. Silent fallbacks risk split-brain dual delivery, duplicate notifications, and masked microservice outages.
- **Zero Secret Leakage**: The adapter never logs the service key, authorization headers, or sensitive notification payloads.

---

## 6. Test and Validation Results

All tests execute in complete isolation without live external network dependencies or running servers.

### Monolith Adapter Unit Tests (`apps/api/test/http-notification-client.test.ts`)
```
✓ test/http-notification-client.test.ts (29 tests)
  - 1. Configuration & Instantiation (6 tests)
  - 2. Interface Conformance (1 test)
  - 3. requestNotification (3 tests)
  - 4. sendTransactionalEmail (2 tests)
  - 5. processPendingNotifications (3 tests)
  - 6. Error Handling, Authentication, Timeouts, and Network Failures (8 tests)
  - 7. Configuration & Feature Flag Validation (6 tests)
Test Files  1 passed (1)
Tests       29 passed (29)
Duration    577ms
```

### Preexisting Monolith Tests
```
✓ test/notification-client.test.ts (6 tests passed)
✓ test/config.test.ts (3 tests passed)
✓ test/events-and-notifications.test.ts (23 tests passed)
✓ test/price-alerts.test.ts (5 tests passed)
✓ test/customer-back-in-stock.test.ts (18 tests passed)
```

### Typecheck and Production Build
```
> @commerce/api@0.1.0 typecheck (tsc --noEmit -p tsconfig.test.json) -> Exit Code 0 (clean)
> @commerce/api@0.1.0 build (tsc -p tsconfig.json)                   -> Exit Code 0 (clean)
```

### Standalone Notifications Service Baseline
```
> @commerce/notifications-service@0.1.0 test (vitest run)
Test Files  6 passed (6)
Tests       51 passed (51)
Duration    1.29s
```

---

## 7. Confirmation of Safety Constraints

- **Local Mode Remains Default**: Confirmed. In all environments without `NOTIFICATION_CLIENT_MODE=http`, `LocalNotificationClient` is selected.
- **No Live HTTP Integration**: Confirmed. All tests utilize mocked `fetch`. No live network calls were dispatched.
- **Zero Modifications to Extracted Service**: `apps/notifications-service/` source and migrations remain untouched.
- **No Database Modification**: No live database connections or migrations were executed against `commerce_db` or `commerce_db_backup`.

---

## 8. Remaining Blockers Before End-to-End Live Integration

Prior to switching traffic or running live end-to-end integration tests between the running monolith and running notifications service:
1. **Shared Event Bus / Outbox Transport Alignment**: In local mode, the monolith dispatches notifications via direct database outbox polling and domain service method calls. In microservice mode, both applications must either share an event transport (e.g., Redis Streams, RabbitMQ) or rely on HTTP delegation.
2. **Database Data Migration & Baseline Synchronization**: Moving customer notification preferences and notification logs from the monolith database to the notifications service database requires a dual-write or migration strategy.
3. **Environment Deployment Configuration**: Deployment manifests (Docker Compose or Kubernetes) need environment variable provisioning for `NOTIFICATION_CLIENT_MODE=http`, `NOTIFICATION_SERVICE_URL`, and a synchronized `NOTIFICATION_SERVICE_KEY` secret.
