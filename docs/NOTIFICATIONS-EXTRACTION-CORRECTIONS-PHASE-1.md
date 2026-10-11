# Notifications Extraction Corrections — Phase 1 Documentation

## 1. Executive Summary

This document records the completion of **Phase 1 Contract and Security Corrections** for the standalone Notifications microservice (`apps/notifications-service/`), resolving the critical findings identified in [`docs/NOTIFICATIONS-EXTRACTION-CONTRACT-AUDIT.md`](./NOTIFICATIONS-EXTRACTION-CONTRACT-AUDIT.md).

All corrections were implemented strictly within `apps/notifications-service/` and its unit tests. **No monolith application code, database schemas, or runtime wiring were modified**, keeping the monolith decoupled and untouched.

---

## 2. Findings Verified Before Implementation

Prior to implementing changes, the audit findings were verified directly against monolith and standalone source implementations:

1. **Transactional Email Semantics:**
   - **Monolith Verification:** [`apps/api/src/modules/notifications/internal/notification-service.ts:276`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-service.ts#L276) demonstrated synchronous dispatch through the provider returning `Promise<string>` (`providerMessageId`). Caller verification in [`apps/api/src/app.ts:499`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/app.ts#L499) and `IdentityService` confirmed that account verification and password reset flows require synchronous send and immediate failure propagation.
   - **Standalone Pre-state:** [`apps/notifications-service/src/domain/notification-service.ts:241`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/domain/notification-service.ts#L241) delegated `sendTransactionalEmail` to `this.requestNotification(...)`, erroneously enqueueing a `PENDING` record in the database and returning `NotificationResultDto`.
2. **Internal Route Security:**
   - **Standalone Pre-state:** [`apps/notifications-service/src/http/routes/internal-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/http/routes/internal-routes.ts) registered `/v1/internal/notifications/request` and `/v1/internal/notifications/transactional-email` with zero authentication or authorization checks.
3. **Event Consumer Lifecycle & Deduplication:**
   - **Monolith Verification:** [`apps/api/src/modules/events/internal/event-consumer.ts:43-145`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/events/internal/event-consumer.ts#L43-L145) acquired a pre-claim receipt with `status = 'PROCESSING'` using `UNIQUE(consumer_name, event_id)` before calling `handleEvent`, and recorded `status = 'FAILED'` on error.
   - **Standalone Pre-state:** [`apps/notifications-service/src/events/notification-event-consumer.ts:26-46`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/events/notification-event-consumer.ts#L26-L46) checked whether the event was already processed, ran `handleEvent(event)`, and only recorded a receipt after execution succeeded. It had a race condition on concurrent delivery and failed to record error state on failure.

---

## 3. Files Changed and Rationale

| File Path | Nature of Change | Architectural Rationale |
|---|---|---|
| [`apps/notifications-service/src/auth/internal-auth.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/auth/internal-auth.ts) | **Created** | Implements `createInternalAuthMiddleware` and `verifyInternalServiceKey` utilizing `crypto.timingSafeEqual` to enforce service-to-service authentication without timing vulnerability. |
| [`apps/notifications-service/src/config/schema.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/config/schema.ts) | **Modified** | Added `INTERNAL_SERVICE_KEY` (minimum 16 characters) with startup refinement that fails fast in production if unconfigured. |
| [`apps/notifications-service/src/config/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/config/index.ts) | **Modified** | Mapped `internalServiceKey` into `NotificationsConfig.auth`. |
| [`apps/notifications-service/src/domain/notification-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/domain/notification-service.ts) | **Modified** | Updated `sendTransactionalEmail` to perform immediate, synchronous dispatch through `this.channels.email.sendEmail(...)`, validate email inputs, return `{ providerMessageId }`, and bypass the notifications database queue. |
| [`apps/notifications-service/src/http/routes/internal-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/http/routes/internal-routes.ts) | **Modified** | Enforced `internalAuth` preHandler on all internal endpoints. Made `tenantId` optional (defaults to `'default'`) on `POST /v1/internal/notifications/transactional-email` and returned `{ providerMessageId }`. |
| [`apps/notifications-service/src/app.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/app.ts) | **Modified** | Wired `createInternalAuthMiddleware(config.auth.internalServiceKey)` into `registerInternalRoutes`. |
| [`apps/notifications-service/src/repository/notification-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/repository/notification-repository.ts) | **Modified** | Added `claimEventReceipt` providing atomic initial claim (`status = 'PROCESSING'`), atomic retry transition (`FAILED -> PROCESSING`), and atomic stale recovery on worker crash. |
| [`apps/notifications-service/src/events/notification-event-consumer.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/events/notification-event-consumer.ts) | **Modified** | Updated `process` and added `processEvent` to acquire a durable processing claim before execution, record `COMPLETED` on success, record `FAILED` with error metadata on failure, and drop concurrent duplicates. |
| [`apps/notifications-service/test/notification-service.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/test/notification-service.test.ts) | **Modified** | Updated transactional email test to verify synchronous dispatch, provider message ID return, input validation, and lack of queue pollution. |
| [`apps/notifications-service/test/http-api.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/test/http-api.test.ts) | **Modified** | Added tests verifying 401 on missing/invalid internal credentials, 200 on valid header/bearer credentials, and synchronous transactional email response shape. |
| [`apps/notifications-service/test/event-consumer.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/test/event-consumer.test.ts) | **Modified** | Added tests verifying concurrent delivery race condition safety (exactly 1 claim succeeds), failure recording with retryability, and stale claim recovery. |

---

## 4. Authentication Contract and Configuration Requirements

### Internal Service-to-Service Contract
Internal routes (`/v1/internal/*`) now require service-level authentication:
- **Accepted Headers:**
  - `X-Internal-Service-Key: <key>`
  - `Authorization: Bearer <key>`
  - `Authorization: InternalKey <key>`
- **Validation:**
  - Uses `crypto.timingSafeEqual` on UTF-8 buffers.
  - Constant-time verification prevents side-channel timing attacks.
  - Rejects missing credentials with `401 Unauthorized` (`code: 'UNAUTHORIZED'`).
  - Rejects invalid credentials with `401 Unauthorized` (`code: 'UNAUTHORIZED'`).
  - Never logs authorization secrets, tokens, or email contents.

### Configuration Requirements
- **Environment Variable:** `INTERNAL_SERVICE_KEY`
- **Validation Rule:** Minimum 16 characters.
- **Production Safety:** In `NODE_ENV === 'production'`, startup validation (`configSchema.refine`) throws an error if `INTERNAL_SERVICE_KEY` is not explicitly set to a custom secret (cannot use development default).
- **Public & Admin Auth:** Public customer preference routes and administrative endpoints remain authenticated via customer and admin HMAC-SHA256 bearer JWTs, completely segregated from internal service-to-service endpoints.

---

## 5. Transactional Email Behavior Before and After

| Aspect | Before (Audit Finding) | After (Phase 1 Fix) |
|---|---|---|
| **Execution Timing** | Asynchronous: enqueued `PENDING` notification in database. | **Synchronous & Immediate:** dispatches directly through `emailProvider.sendEmail(...)`. |
| **Return Shape** | Returned `NotificationResultDto` (`{ notificationId, status: 'PENDING' }`). | **Matches Monolith Contract:** returns `{ providerMessageId: string }`. |
| **Error Handling** | Swallowed downstream dispatch failures into retry queue. | **Immediate Propagation:** throws `ValidationError` or provider errors back to the caller. |
| **Tenant Context** | Required explicit `tenantId` in payload. | **Optional `tenantId`:** defaults to `'default'`, aligning with IdentityService calls. |
| **Marketing Preferences** | N/A (queued) | **Direct Provider Dispatch:** explicitly bypasses marketing opt-outs as security-required messages. |
| **Database Queue** | Created rows in `notifications` table. | **Zero Queue Pollution:** does not create rows in `notifications` table. |

---

## 6. Event Lifecycle, Concurrency Protection, and Retries

### State Machine Lifecycle in `notification_consumer_receipts`
```
                [Event Arrives]
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
    [No Existing Receipt]  [Existing Receipt]
             │                   │
             │           ┌───────┴──────────────────┐
             │           ▼                          ▼
             │      status == 'COMPLETED'      status == 'FAILED'
             │           │                          │
             │           ▼                          ▼
             │      [SKIP (Duplicate)]       Atomic UPDATE to 'PROCESSING'
             │                                      │
    Atomic INSERT 'PROCESSING'                      │
             │                                      │
             └───────────────────┬──────────────────┘
                                 ▼
                     [Exclusive Claim Acquired]
                                 │
                     ┌───────────┴───────────┐
                     ▼                       ▼
            [handleEvent Succeeds]  [handleEvent Fails]
                     │                       │
                     ▼                       ▼
              UPDATE status to        UPDATE status to
                'COMPLETED'               'FAILED'
                                       (with error metadata)
```

### Concurrency and Reliability Guarantees
1. **Concurrent Delivery Protection:**
   - On the first delivery of an event, multiple workers race to insert `status = 'PROCESSING'`.
   - The PostgreSQL constraint `CONSTRAINT uq_notification_consumer_receipt UNIQUE (consumer_name, event_id)` permits exactly **one** insert to succeed.
   - Sibling workers receive a constraint conflict, catch the collision, log a skip, and exit without executing `handleEvent`.
2. **Failure and Retry Safety:**
   - When an unhandled error occurs during event processing, the consumer records `status = 'FAILED'` along with the error message and timestamp in `error_metadata`.
   - The event is NOT marked completed. When the message broker or publisher redelivers the event, `claimEventReceipt` recognizes `status == 'FAILED'` and atomically updates it back to `'PROCESSING'`.
   - If the retry succeeds, the status transitions to `'COMPLETED'`.
3. **Stale Claim Recovery:**
   - If a container or worker process abruptly terminates while an event is in `status = 'PROCESSING'`, subsequent redeliveries check the elapsed time since `processed_at`.
   - If `elapsedMs >= staleTimeoutMs` (default 5 minutes), the consumer atomically reclaims the receipt and reprocesses the event.
4. **Remaining Risk & Defense-in-Depth:**
   - *Risk:* If a worker sends an external email/SMS but the database crashes *before* the receipt can be updated from `'PROCESSING'` to `'COMPLETED'`, a subsequent retry could re-execute the event.
   - *Mitigation:* The event handler invokes `notificationService.requestNotification(...)`, which relies on the unique constraint `CONSTRAINT uq_notification_idempotency UNIQUE (tenant_id, idempotency_key)`. The inner notification request is deduplicated even if the consumer receipt was interrupted, ensuring downstream idempotency.

---

## 7. Tests and Validation Results

All tests across both services were executed using isolated runners without starting servers:

1. **`apps/notifications-service` Test Suite:**
   - Test files passed: **6 of 6**
   - Individual tests passed: **45 of 45** (increased from 37)
   - Covered suites:
     - `test/auth-boundary.test.ts` (HMAC token verification, role permissions)
     - `test/channel-provider.test.ts` (Email, SMS, Push providers)
     - `test/notification-repository.test.ts` (CRUD, claiming, preferences)
     - `test/notification-service.test.ts` (Synchronous transactional email, idempotency, retry backoff)
     - `test/event-consumer.test.ts` (All 6 event mappings, concurrent claim safety, failure retries, stale claim recovery)
     - `test/http-api.test.ts` (Health/ready checks, admin auth, customer preferences, internal service auth)
2. **TypeScript Compilation & Build:**
   - `npm run typecheck`: **0 errors**
   - `npm run build`: **0 errors**
3. **Monolith Seam Regression Test:**
   - `apps/api/test/notification-client.test.ts`: **6 of 6 passed**

---

## 8. Unresolved Audit Findings & Recommended Next Step

### Remaining Non-Critical Audit Items (For Subsequent Phases)
1. **API Entity vs Boolean Return on Manual Retry:** Monolith `POST /notifications/:id/retry` returns `{ retried: true }`, whereas standalone returns the full `NotificationRecord`.
2. **Observability / Request Correlation:** Fastify error responses do not currently include `correlationId` and `requestId`.
3. **Background Processing Daemon:** Monolith runs a 30s `setInterval` flusher; standalone currently relies on `POST /notifications/process` HTTP trigger.

### Recommended Next Step
**Implement Monolith-Side `HttpNotificationClient` (Feature-Flagged Adapter):**
Create the HTTP client implementing `INotificationClient` inside `apps/api/src/modules/notifications/internal/` that connects to the standalone service, passing `X-Internal-Service-Key` and parsing the synchronous `{ providerMessageId }` transactional email response.
