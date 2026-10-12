# Notifications Extraction Contract and Behavioral Gap Audit — READ ONLY

## 1. Executive Summary

### Executive Verdict: **READY FOR CORRECTIONS**

The standalone Notifications microservice under `apps/notifications-service/` successfully establishes a clean, decoupled service boundary, independent configuration, strict database ownership, and isolated persistence. However, a rigorous code-level audit against the existing monolithic implementation (`apps/api`) revealed **several critical behavioral and contract discrepancies** that must be resolved before proceeding to runtime integration review, `HttpNotificationClient` wiring, or traffic cutover.

### Key Audit Findings:

1. **Critical Behavioral Mismatch — Transactional Email Delivery Semantics:** The monolith's `sendTransactionalEmail` performs **immediate, synchronous delivery** through the channel provider and returns a `providerMessageId: string`, which is relied upon by `IdentityService` for account verification and password resets. In contrast, the standalone service's `sendTransactionalEmail` enqueues an asynchronous `PENDING` notification in the database returning `NotificationResultDto`, meaning verification emails are deferred until a separate batch processing run occurs. Furthermore, the internal HTTP route strictly mandates `tenantId`, which `IdentityService` does not possess.
2. **Critical Security Finding — Unauthenticated Internal Endpoints:** The internal endpoints `POST /v1/internal/notifications/request` and `POST /v1/internal/notifications/transactional-email` in `apps/notifications-service/src/http/routes/internal-routes.ts` have **zero authentication or authorization checks**.
3. **High Reliability Finding — Event Consumer Lifecycle and Concurrency:** Monolith's `BaseEventConsumer` enforces a robust multi-stage state machine (`PROCESSING` pre-claim -> domain execution -> `COMPLETED` / `FAILED`, plus version-based `QUARANTINED`). The standalone `NotificationEventConsumer` executes the handler first and records a receipt only on success, exposing the consumer to concurrent execution race conditions and failing to track error states.
4. **High Operational Gap — Missing Background Processor Daemon:** The monolith executes an automatic `setInterval` loop every 30 seconds to flush pending notifications. The standalone service has no background loop or scheduler, relying entirely on manual `POST /notifications/process` HTTP triggers.
5. **Medium Contract Mismatches — API Response Shapes & Observability:** Discrepancies exist in `POST /notifications/:id/retry` response body (`{ retried: true }` vs full entity), error responses missing `correlationId` and `requestId`, and preference suppression status (`'PENDING'` vs `'SKIPPED'`).

---

## 2. Scope & Inspected Source Files

### Monolith Implementation (`apps/api/`)

- `apps/api/src/modules/notifications/index.ts`
- `apps/api/src/modules/notifications/internal/notification-models.ts`
- `apps/api/src/modules/notifications/internal/notification-service.ts`
- `apps/api/src/modules/notifications/internal/notification-repository.ts`
- `apps/api/src/modules/notifications/internal/notification-consumer.ts`
- `apps/api/src/modules/notifications/internal/notification-client.ts`
- `apps/api/src/modules/notifications/internal/channel-providers.ts`
- `apps/api/src/http/event-routes.ts`
- `apps/api/src/modules/events/internal/event-consumer.ts`
- `apps/api/src/modules/events/internal/event-envelope.ts`
- `apps/api/src/modules/events/internal/outbox-repository.ts`
- `apps/api/src/modules/identity/internal/token-service.ts`
- `apps/api/src/modules/price-alerts/internal/price-alert-service.ts`
- `apps/api/src/modules/customer/internal/back-in-stock-service.ts`
- `apps/api/src/infra/database/migrations/0009_events_and_notifications_schema.sql`
- `apps/api/src/app.ts` (wiring lines 36, 495–501, 598–617)
- `apps/api/src/errors/handler.ts`

### Standalone Service Implementation (`apps/notifications-service/`)

- `apps/notifications-service/src/domain/models.ts`
- `apps/notifications-service/src/domain/notification-service.ts`
- `apps/notifications-service/src/repository/notification-repository.ts`
- `apps/notifications-service/src/infra/database/connection.ts`
- `apps/notifications-service/src/infra/database/migrations/0001_notifications_service_schema.sql`
- `apps/notifications-service/src/infra/database/migrations/runner.ts`
- `apps/notifications-service/src/auth/token-verifier.ts`
- `apps/notifications-service/src/auth/auth-middleware.ts`
- `apps/notifications-service/src/events/event-models.ts`
- `apps/notifications-service/src/events/notification-event-consumer.ts`
- `apps/notifications-service/src/channels/channel-provider.ts`
- `apps/notifications-service/src/channels/resend-provider.ts`
- `apps/notifications-service/src/channels/in-memory-providers.ts`
- `apps/notifications-service/src/config/schema.ts`
- `apps/notifications-service/src/config/index.ts`
- `apps/notifications-service/src/errors/app-error.ts`
- `apps/notifications-service/src/errors/handler.ts`
- `apps/notifications-service/src/http/routes/health-routes.ts`
- `apps/notifications-service/src/http/routes/notification-routes.ts`
- `apps/notifications-service/src/http/routes/preference-routes.ts`
- `apps/notifications-service/src/http/routes/internal-routes.ts`
- `apps/notifications-service/src/app.ts`
- `apps/notifications-service/src/server.ts`
- `apps/notifications-service/test/*`

---

## 3. Requirement-by-Requirement Behavioral Comparison Matrix

| #   | Behavioral Domain                                    | Classification         | Monolith Source & Behavior                                                                                                                                                      | Standalone Source & Behavior                                                                                                                                                       | Evidence & Analysis                                                                                                                         |
| --- | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Notification Creation & Validation**               | **INTENTIONAL CHANGE** | `notification-service.ts:39`<br>Requires `tenantId`, `eventId`, `notificationType`, `channel`, `recipient`, `templateId`.                                                       | `domain/notification-service.ts:25`<br>Requires `tenantId`, `notificationType`, `channel`, `recipient`. Auto-generates `eventId` and `templateId` defaults if omitted.             | Standalone is strictly backward-compatible with callers providing all fields while offering sensible defaults for ad-hoc callers.           |
| 2   | **Type, Channel, Recipient & Tenant Handling**       | **MATCH**              | `notification-models.ts:1-22`<br>Channels: `EMAIL`, `SMS`, `PUSH`. Payloads: `JSONB`. Identifiers: `tenant_id`, `recipient`.                                                    | `domain/models.ts:1-23`<br>Identical enum, channels, payload handling, and multi-tenant identifier preservation.                                                                   | Checked by database check constraints and domain types in both codebases.                                                                   |
| 3   | **Idempotency Keys & Deduplication**                 | **MATCH**              | `notification-service.ts:115-171`<br>Key: `${eventId}:${notificationType}:${recipient}:${channel}`.<br>Pre-insert query + catch on UNIQUE collision.                            | `domain/notification-service.ts:89-132`<br>Exact identical key formula and race-condition catch returning existing record.                                                         | Proven by `test/notification-service.test.ts` scenario "enforces idempotency on duplicate notification requests".                           |
| 4   | **Pending Claiming & Concurrency Safety**            | **MATCH**              | `notification-repository.ts:173-209`<br>`SELECT ... LIMIT $1` followed by conditional `UPDATE ... WHERE id = $1 AND (status = 'PENDING' OR status = 'RETRY_SCHEDULED')`.        | `repository/notification-repository.ts:170-208`<br>Exact identical transaction-wrapped conditional update claiming logic.                                                          | Concurrency behavior matches. Both lack `FOR UPDATE SKIP LOCKED` (see Section 5).                                                           |
| 5   | **Retry Eligibility, Backoff & Max Attempts**        | **MATCH**              | `notification-service.ts:220-240`<br>Exponential backoff: $delay = baseDelay \times 2^{attempts-1}$. Updates status to `RETRY_SCHEDULED`.                                       | `domain/notification-service.ts:172-175`<br>Exact identical formula, statuses, and retry calculations.                                                                             | Proven by `test/notification-service.test.ts` scenario "handles retry and exponential backoff".                                             |
| 6   | **Failed & Dead-Letter Behavior**                    | **MATCH**              | `notification-service.ts:222-229`<br>When $attempts \ge maxAttempts$, transitions to `DEAD_LETTERED`, records `last_error`.                                                     | `domain/notification-service.ts:166-171`<br>Exact identical transition to `DEAD_LETTERED` and error recording.                                                                     | Matches schema check constraint `chk_notification_status`.                                                                                  |
| 7   | **Manual Retry Authorization & Status Transitions**  | **MISMATCH**           | `event-routes.ts:145`, `notification-service.ts:359`<br>Admin-only. Updates only `FAILED` or `DEAD_LETTERED` rows to `PENDING`. Returns `{ retried: true }`.                    | `notification-routes.ts:72`, `domain/notification-service.ts:348`<br>Admin-only. Exact identical query, but returns **full `NotificationRecord` entity**.                          | Return contract mismatch: `{ retried: true }` vs `NotificationRecord`.                                                                      |
| 8   | **Customer Preferences & Suppression**               | **MISMATCH**           | `notification-service.ts:47-111`<br>Suppresses channels/types based on opt-out. Returns `{ status: 'PENDING', skipped: true, reason: '...' }`.                                  | `domain/notification-service.ts:52-85`<br>Suppresses channels/types based on opt-out. Returns `{ status: 'SKIPPED', skipped: true, reason: '...' }`.                               | Contract mismatch on `status` field: `'PENDING'` vs `'SKIPPED'`.                                                                            |
| 9   | **Transactional Email Delivery**                     | **CRITICAL MISMATCH**  | `notification-service.ts:276`<br>`sendTransactionalEmail(to, subject, body): Promise<string>`. Synchronous, direct provider dispatch, unpersisted, returns `providerMessageId`. | `domain/notification-service.ts:200`<br>`sendTransactionalEmail`: enqueues asynchronous `PENDING` record in database returning `NotificationResultDto`. Route mandates `tenantId`. | **Breaks Identity Service contract.** Verification and password reset emails are delayed until batch process. Missing `tenantId` in caller. |
| 10  | **Resend Channel Provider Integration**              | **MATCH**              | `channel-providers.ts:33-70`<br>HTML paragraph formatting, native `fetch` to `https://api.resend.com/emails`, error extraction.                                                 | `channels/resend-provider.ts:7-43`<br>Exact identical character-for-character implementation.                                                                                      | Tests mock `fetch` and verify payload, auth headers, and response parsing identically.                                                      |
| 11  | **Event-to-Notification Mapping**                    | **MATCH**              | `notification-consumer.ts:39-175`<br>Maps all 6 events (`order.created`, `payment.succeeded`, `payment.failed`, `fulfillment.shipment`, `fulfillment.return`, `settlement`).    | `events/notification-event-consumer.ts:52-188`<br>Exact identical mapping of subjects, bodies, recipients, and template IDs for all 6 events.                                      | Proven by `test/event-consumer.test.ts`.                                                                                                    |
| 12  | **Event Consumer Receipt Lifecycle & Deduplication** | **HIGH MISMATCH**      | `events/internal/event-consumer.ts:43-145`<br>Pre-claims receipt with `PROCESSING`. Checks version support -> `QUARANTINED`. On error -> `FAILED`.                              | `events/notification-event-consumer.ts:26-46`<br>No version check. No pre-claim with `PROCESSING`. Records receipt only _after_ handling completes. No `FAILED` recording.         | Race condition under concurrent delivery. Missing failure state in receipts table.                                                          |
| 13  | **Authentication Claims & Expiration**               | **MATCH**              | `identity/internal/token-service.ts:45-90`<br>Claims `sub`, `tid`, `rol`, `exp`. Signature: `SHA256(header.claims.secret)`.                                                     | `auth/token-verifier.ts:24-59`<br>Exact identical signature calculation, claim extraction, role validation, and expiration check.                                                  | Proven by `test/auth-boundary.test.ts`. Both share string equality for signature (see Section 5).                                           |
| 14  | **API Routes, Response Shapes & Error Format**       | **MISMATCH**           | `event-routes.ts`, `errors/handler.ts`<br>Error envelope includes `correlationId` and `requestId`. Prehandlers decorate Fastify request.                                        | `http/routes/*`, `errors/handler.ts`<br>Error envelope lacks `correlationId` and `requestId`. Service lacks correlation hooks.                                                     | Observability and error schema mismatch.                                                                                                    |
| 15  | **Background Processing Cadence**                    | **MISSING**            | `app.ts:598-617`<br>Runs `setInterval` every 30s to process pending notifications automatically with an overlap guard.                                                          | `app.ts`, `server.ts`<br>No background interval or scheduler exists. Only manual `POST /notifications/process` HTTP endpoint.                                                      | Standalone service cannot deliver queued notifications autonomously without an external cron or internal loop.                              |
| 16  | **Database Constraints, Indexes & Schema Ownership** | **MATCH**              | `0009_events_and_notifications_schema.sql`<br>Tables: `customer_notification_preferences`, `notifications`, `event_consumer_receipts`.                                          | `0001_notifications_service_schema.sql`<br>Tables: `customer_notification_preferences`, `notifications`, `notification_consumer_receipts`.                                         | Identical columns, indexes, and constraints. Table renaming is an **INTENTIONAL CHANGE** for bounded context naming.                        |
| 17  | **Callers of INotificationClient**                   | **MISMATCH**           | Callers: `PriceAlertService`, `BackInStockService`, `IdentityService` (`verification.sendEmail`), background loop.                                                              | Standalone routes support `requestNotification` but transactional email semantics diverge for Identity.                                                                            | Price Alerts and Back-in-Stock match contract; Identity caller is incompatible with async queue.                                            |
| 18  | **Config, Build & Health/Readiness**                 | **MATCH**              | Monolith config parsed via Zod. Monolith builds and tests cleanly.                                                                                                              | `config/index.ts`, `health-routes.ts`<br>Independent build, strict Zod validation, `/health` and `/ready` (verifies DB query `SELECT 1`).                                          | Standalone service builds and typechecks with zero errors in complete isolation.                                                            |

---

## 4. Security and Reliability Review

### 4.1 Token Verification & Cryptographic Algorithm

- **Source Inspection:**
  - Monolith Identity: `apps/api/src/modules/identity/internal/token-service.ts` (lines 47–61)
  - Standalone: `apps/notifications-service/src/auth/token-verifier.ts` (lines 31–34)
- **Findings:**
  - The standalone `HmacTokenVerifier` faithfully reproduces the proprietary HMAC/SHA-256 scheme used by the monolith:
    $$\text{signature} = \text{SHA256}(\text{header}.\text{claims}.\text{secret})$$
  - Claim parsing correctly maps `sub` $\to$ `userId`, `tid` $\to$ `tenantId`, `rol` $\to$ `role`, and validates `exp > now`.
  - **Security Observation:** Both implementations use standard string comparison `sig !== expectedSig` rather than `crypto.timingSafeEqual`. This is a pre-existing monolith characteristic, but should be noted as a theoretical timing vulnerability.

### 4.2 Administrative Authorization

- **Source Inspection:**
  - Monolith: `apps/api/src/http/event-routes.ts` (lines 98, 124, 140, 156)
  - Standalone: `apps/notifications-service/src/http/routes/notification-routes.ts` (lines 19, 48, 67, 86)
- **Findings:**
  - All four admin routes (`GET /notifications`, `GET /notifications/:id`, `POST /notifications/:id/retry`, `POST /notifications/process`) strictly enforce `actor.role === 'ADMINISTRATOR'`.
  - Non-administrators (`CUSTOMER`, `MERCHANT`) receive `403 Forbidden`.
  - Unauthenticated requests receive `401 Unauthorized`.
  - **Verdict:** Fully preserved and secure.

### 4.3 Customer Preference Isolation & Tenant Isolation

- **Source Inspection:**
  - Monolith: `apps/api/src/http/event-routes.ts` (lines 173–175, 196–198)
  - Standalone: `apps/notifications-service/src/http/routes/preference-routes.ts` (lines 18–19, 44–45)
- **Findings:**
  - Customers cannot read or manipulate another customer's preferences. `tenantId` and `customerId` are strictly pulled from the verified token actor (`actor.tenantId`, `actor.userId`).
  - Query parameters or request body values for customer ID are ignored.
  - In `NotificationRepository`, `customer_notification_preferences` queries enforce `WHERE tenant_id = $1 AND customer_id = $2`.
  - **Verdict:** Fully preserved and secure.

### 4.4 Internal API Protection (CRITICAL DEFECT)

- **Source Inspection:**
  - Standalone: `apps/notifications-service/src/http/routes/internal-routes.ts` (lines 10–79)
- **Findings:**
  - Neither `POST /v1/internal/notifications/request` nor `POST /v1/internal/notifications/transactional-email` uses `authMiddleware` or checks any API key or shared secret.
  - **Vulnerability:** If deployed on a shared network or exposed via a reverse proxy without strict route whitelisting, anyone can forge notification records or trigger transactional emails to arbitrary recipients.
  - **Correction Required:** Introduce an internal authentication guard (e.g. `x-internal-service-token` or mutual TLS) matching inter-service communication standards.

### 4.5 Delivery Idempotency & Failure Windows

- **Source Inspection:**
  - Standalone: `apps/notifications-service/src/domain/notification-service.ts` (lines 158–176)
- **Findings:**
  - In `processPendingNotifications`:
    ```ts
    await this.dispatchToChannel(record);
    await this.repo.markSent(record.id);
    ```
  - If `dispatchToChannel` succeeds (e.g. Resend delivers the email) but the database connection fails before `markSent` executes, the record remains in `PROCESSING` or encounters an error.
  - This is an inherent property of at-least-once delivery over distributed network boundaries. Resend does not support distributed two-phase commits. However, Resend does support an `Idempotency-Key` HTTP header. Neither monolith nor standalone currently passes `record.idempotencyKey` to the Resend API headers. Passing this header to Resend would make external channel delivery truly idempotent across database retries.

### 4.6 Concurrency in Queue Claiming

- **Source Inspection:**
  - Standalone: `apps/notifications-service/src/repository/notification-repository.ts` (lines 170–208)
- **Findings:**
  - `claimPendingNotifications` uses a transaction with `SELECT ... LIMIT $1` followed by an optimistic conditional `UPDATE ... WHERE id = $1 AND (status = 'PENDING' OR status = 'RETRY_SCHEDULED')`.
  - If two instances select the same batch simultaneously, the first instance's update succeeds and the second instance gets `rowCount === 0`, successfully preventing double processing.
  - However, under high concurrency, both instances lock and contend on the same ordered rows. Standard PostgreSQL queue architecture uses `SELECT ... FOR UPDATE SKIP LOCKED`.

### 4.7 Event Consumer Reliability & Loss Window

- **Source Inspection:**
  - Standalone: `apps/notifications-service/src/events/notification-event-consumer.ts` (lines 26–46)
- **Findings:**
  - If `handleEvent(event)` fails midway:
    1. The exception bubbles up without writing a `FAILED` receipt.
    2. Because `isEventProcessed` was false, a redelivery will execute `handleEvent(event)` again. While this allows retries, any partially executed side-effects (like a successfully created notification before a subsequent step threw) could be repeated.
  - If two workers receive the same event simultaneously:
    1. Neither worker sees an existing receipt because receipts are only written _after_ processing.
    2. Both workers call `handleEvent(event)` simultaneously.
    3. The second worker to finish attempts to insert `notification_consumer_receipts` and crashes with a `UNIQUE` constraint violation instead of cleanly skipping.

### 4.8 Readiness Endpoint Authenticity

- **Source Inspection:**
  - Standalone: `apps/notifications-service/src/http/routes/health-routes.ts` (lines 14–33)
- **Findings:**
  - `GET /ready` performs a real database query `SELECT 1`.
  - Returns `200` with `{ status: 'ready', database: 'connected' }` when PostgreSQL is responsive.
  - Returns `503` with `{ status: 'not_ready', database: 'disconnected', error: ... }` when the database fails.
  - **Verdict:** Valid and genuine dependency check.

---

## 5. API and DTO Compatibility Table

| Endpoint                                              | Monolith Signature & Shape                                                                                                   | Standalone Service Signature & Shape                                                                                                                          | Status                | Details                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /health`                                         | (Not in `event-routes.ts`, defined globally)                                                                                 | `{ status: 'ok', service: 'notifications-service', timestamp: string }`                                                                                       | **MATCH**             | Standard microservice health check                                                                       |
| `GET /ready`                                          | (Not in `event-routes.ts`, defined globally)                                                                                 | `{ status: 'ready', service: 'notifications-service', database: 'connected', timestamp: string }`                                                             | **MATCH**             | Valid dependency health probe                                                                            |
| `GET /notifications`                                  | Query: `tenantId?`, `status?`, `channel?`, `limit?`, `offset?`<br>Response: `{ items: NotificationRecord[], total: number }` | Query: Identical<br>Response: `{ data: NotificationRecord[], items: NotificationRecord[], total: number }`                                                    | **MATCH**             | Backward compatible (includes both `items` and `data`)                                                   |
| `GET /notifications/:id`                              | Param: `id`<br>Response: `NotificationRecord`                                                                                | Param: `id`<br>Response: `NotificationRecord`                                                                                                                 | **MATCH**             | Exact contract match                                                                                     |
| `POST /notifications/:id/retry`                       | Param: `id`<br>Response: `{ retried: true }`                                                                                 | Param: `id`<br>Response: `NotificationRecord`                                                                                                                 | **MISMATCH**          | Monolith frontend / admin caller expects `{ retried: boolean }`                                          |
| `POST /notifications/process`                         | Body: `{ batchSize?: number }`<br>Response: `{ claimed: number, sent: number, failed: number, deadLettered: number }`        | Body: `{ batchSize?: number }`<br>Response: `{ claimed: number, sent: number, failed: number, deadLettered: number, processed: number }`                      | **MATCH**             | Backward compatible superset                                                                             |
| `GET /customers/me/notification-preferences`          | Response: `CustomerNotificationPreference`                                                                                   | Response: `CustomerNotificationPreference`                                                                                                                    | **MATCH**             | Exact contract match                                                                                     |
| `PUT /customers/me/notification-preferences`          | Body: `{ emailEnabled?, smsEnabled?, pushEnabled?, disabledTypes? }`<br>Response: `CustomerNotificationPreference`           | Body: Identical<br>Response: Identical                                                                                                                        | **MATCH**             | Exact contract match                                                                                     |
| `POST /v1/internal/notifications/request`             | (Monolith: in-memory `requestNotification(input)`)                                                                           | Body: `{ tenantId, customerId?, eventId?, notificationType, channel, recipient, templateId?, payload, idempotencyKey? }`<br>Response: `NotificationResultDto` | **NEW SEAM**          | Matches future `HttpNotificationClient` requirements                                                     |
| `POST /v1/internal/notifications/transactional-email` | (Monolith: in-memory `sendTransactionalEmail(to, subject, body): Promise<string>`)                                           | Body: `{ tenantId, recipient, subject, body, templateId?, metadata?, idempotencyKey? }`<br>Response: `NotificationResultDto`                                  | **CRITICAL MISMATCH** | Body requires `tenantId` (monolith caller does not have it). Returns DTO instead of `providerMessageId`. |
| Error Response Format                                 | `{ error: { code, message, statusCode, correlationId, requestId, details? } }`                                               | `{ error: { code, message, statusCode, details? } }`                                                                                                          | **MISMATCH**          | Missing `correlationId` and `requestId` fields                                                           |

---

## 6. Database Schema and Ownership Comparison

| Entity / Table                      | Monolith Schema (`0009`)                                                                                                                                                                                                                                                                                                                                                         | Standalone Schema (`0001`)                                                                                                                                                                                                     | Comparison & Ownership Assessment                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_notification_preferences` | `id VARCHAR(64) PRIMARY KEY`, `tenant_id VARCHAR(36)`, `customer_id VARCHAR(64)`, `email_enabled`, `sms_enabled`, `push_enabled`, `disabled_types TEXT`, `UNIQUE(tenant_id, customer_id)`, index on `(tenant_id, customer_id)`                                                                                                                                                   | `id VARCHAR(64) PRIMARY KEY`, `tenant_id VARCHAR(36)`, `customer_id VARCHAR(64)`, `email_enabled`, `sms_enabled`, `push_enabled`, `disabled_types TEXT`, `UNIQUE(tenant_id, customer_id)`, index on `(tenant_id, customer_id)` | **EXACT MATCH.** Service owns table. Zero foreign keys to `users`.                                                                                                                                                     |
| `notifications`                     | `id VARCHAR(64) PRIMARY KEY`, `tenant_id VARCHAR(36)`, `event_id VARCHAR(64)`, `notification_type`, `channel`, `recipient`, `idempotency_key UNIQUE`, `template_id`, `payload JSONB`, `status`, `attempt_count`, `max_attempts`, `available_at`, `sent_at`, `last_error`, `created_at`, `updated_at`. Indexes on `(status, available_at)`, `tenant_id`, `event_id`, `recipient`. | Identical column definitions, data types, defaults, unique constraints, and indexes.                                                                                                                                           | **EXACT MATCH.** Service owns table. Zero foreign keys to orders/catalog.                                                                                                                                              |
| Consumer Receipts                   | Table: `event_consumer_receipts`<br>Constraint: `uq_consumer_event_receipt`<br>Check: `chk_receipt_status`                                                                                                                                                                                                                                                                       | Table: `notification_consumer_receipts`<br>Constraint: `uq_notification_consumer_receipt`<br>Check: `chk_notification_receipt_status`                                                                                          | **INTENTIONAL CHANGE.** Renamed table to `notification_consumer_receipts` to establish clear bounded context ownership. Columns and constraints match.                                                                 |
| Status Check Constraint             | `chk_notification_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'DEAD_LETTERED'))`                                                                                                                                                                                                                                                      | Identical check constraint.                                                                                                                                                                                                    | **NOTE:** In TypeScript domain models, `'SKIPPED'` was added to `NotificationStatus`. The database check constraint does NOT allow `'SKIPPED'`. If skipped notifications were persisted, PostgreSQL would reject them. |

---

## 7. Event Mapping and Idempotency Comparison

### 7.1 Domain Event Mapping

| Monolith Event                           | Monolith Payload Fields                                                               | Standalone Handled Payload                                                            | Target Notification Type | Channel | Recipient       |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------ | ------- | --------------- |
| `order.created.v1`                       | `customerEmail`, `customerId`, `totalAmount`                                          | `customerEmail`, `customerId`, `totalAmount`                                          | `ORDER_CONFIRMATION`     | `EMAIL` | `customerEmail` |
| `payment.succeeded.v1`                   | `customerEmail`, `customerId`, `amount`, `currency`                                   | `customerEmail`, `customerId`, `amount`, `currency`                                   | `PAYMENT_RECEIPT`        | `EMAIL` | `customerEmail` |
| `payment.failed.v1`                      | `customerEmail`, `customerId`, `orderId`, `amount`, `reason`                          | `customerEmail`, `customerId`, `orderId`, `amount`, `reason`                          | `PAYMENT_FAILURE_ALERT`  | `EMAIL` | `customerEmail` |
| `fulfillment.shipment_status_changed.v1` | `customerEmail`, `customerId`, `status`, `trackingNumber`                             | `customerEmail`, `customerId`, `status`, `trackingNumber`                             | `SHIPMENT_STATUS_UPDATE` | `EMAIL` | `customerEmail` |
| `fulfillment.return_status_changed.v1`   | `customerEmail`, `customerId`, `status`                                               | `customerEmail`, `customerId`, `status`                                               | `RETURN_STATUS_UPDATE`   | `EMAIL` | `customerEmail` |
| `settlement.status_changed.v1`           | `merchantEmail`, `status`, `periodStart`, `periodEnd`, `netPayableAmount`, `currency` | `merchantEmail`, `status`, `periodStart`, `periodEnd`, `netPayableAmount`, `currency` | `SETTLEMENT_UPDATE`      | `EMAIL` | `merchantEmail` |

All 6 event mappings match the existing monolith implementation with 100% fidelity.

### 7.2 Consumer Deduplication Architecture

- **Monolith:** Deduplication is multi-layered:
  1. Consumer receipt check (`event_consumer_receipts`).
  2. Transactional outbox lease lock.
  3. Notification table `idempotency_key` unique constraint (`${eventId}:${notificationType}:${recipient}:${channel}`).
- **Standalone Service:** Deduplication relies on:
  1. Receipt check in `notification_consumer_receipts` (post-execution).
  2. Notification table `idempotency_key` unique constraint.
- **Assessment:** While notification table idempotency ensures double-insertion cannot occur, missing the pre-claim `PROCESSING` receipt allows duplicate event handler execution under concurrent broker redelivery.

---

## 8. Prioritized List of Confirmed Corrections

Before the standalone service can be accepted for cutover, the following small, focused corrections must be implemented:

1. **[P0 - Critical] Restore Immediate Synchronous Delivery for Transactional Email:**
   - In `apps/notifications-service/src/domain/notification-service.ts`: Update `sendTransactionalEmail` to directly call `this.channels.email.sendEmail(...)` without queuing a `PENDING` record, returning the `providerMessageId` string to preserve `IdentityService` verification semantics.
   - In `apps/notifications-service/src/http/routes/internal-routes.ts`: Make `tenantId` optional on `POST /v1/internal/notifications/transactional-email` (defaulting to `'default'`), and return `{ providerMessageId }`.
2. **[P0 - Critical] Secure Internal Endpoints:**
   - Add an internal service secret authorization check or preHandler middleware to `apps/notifications-service/src/http/routes/internal-routes.ts` protecting `/v1/internal/*` from unauthorized external access.
3. **[P1 - High] Implement Complete Event Consumer State Machine:**
   - Update `NotificationEventConsumer.process` to insert `status = 'PROCESSING'` into `notification_consumer_receipts` _before_ calling `handleEvent`.
   - On error, update the receipt to `status = 'FAILED'` with error details.
   - On success, update the receipt to `status = 'COMPLETED'`.
   - Check event schema versions and record `QUARANTINED` for unsupported versions.
4. **[P1 - High] Implement Background Notification Processing Interval:**
   - Add an opt-in background processing timer (e.g. 30s interval with concurrency lock) to `apps/notifications-service/src/app.ts` / `server.ts` active when `NODE_ENV !== 'test'`.
5. **[P2 - Medium] Align API Response Shapes and Observability:**
   - Fix `POST /notifications/:id/retry` to return `{ retried: true }`.
   - Add Fastify request correlation middleware extracting/generating `x-correlation-id` and `x-request-id`.
   - Include `correlationId` and `requestId` in error responses in `apps/notifications-service/src/errors/handler.ts`.
   - Reconcile preference opt-out status return (`status: 'PENDING', skipped: true` vs `status: 'SKIPPED'`).

---

## 9. Explicit Items Requiring Later Integration Testing

The following items cannot be fully verified with isolated unit tests and must be tested during subsequent integration phases:

1. **Cross-Service Network Latency & Timeout Behavior:** Verifying whether `HttpNotificationClient` calls from the monolith (e.g. from `PriceAlertService` or `BackInStockService`) handle network timeouts, retries, and circuit breaking gracefully under load.
2. **Real PostgreSQL Concurrency & Lock Contention:** Testing `claimPendingNotifications` under multi-worker concurrency on a real PostgreSQL cluster to determine whether `FOR UPDATE SKIP LOCKED` is required to avoid transaction serialization conflicts.
3. **Production Token Expiry & Clock Skew:** Verifying that tokens generated by the monolith Identity service in production environments validate cleanly across container clocks without clock-drift issues.
4. **Message Broker Transport Interoperability:** Testing the consumption of real messages from a broker (Redis Streams, RabbitMQ, Kafka) deserializing into `DomainEvent` envelopes and feeding `NotificationEventConsumer`.
5. **Live Resend API Error Responses:** Verifying real Resend rate-limiting (HTTP 429) and invalid email domain handling against live Resend endpoints.

---

## 10. Recommended Next Implementation Step

### Recommended Step: **Phase 1 Seam Polish & Contract Alignment**

Apply the narrowly scoped corrections identified above strictly within `apps/notifications-service/`:

1. Align `sendTransactionalEmail` in both the domain service and internal HTTP route to match the synchronous `providerMessageId` contract.
2. Add internal authorization token verification to `/v1/internal/*` routes.
3. Align `POST /notifications/:id/retry` return payload to `{ retried: true }`.
4. Implement the pre-claiming `PROCESSING` state machine in `NotificationEventConsumer`.
5. Add correlation ID middleware and align error response envelopes.

**Do NOT wire `HttpNotificationClient` in the monolith until these standalone contract gaps are closed and verified.**
