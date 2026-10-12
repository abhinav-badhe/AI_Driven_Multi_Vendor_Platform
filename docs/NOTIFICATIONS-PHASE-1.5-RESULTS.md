# Notifications Extraction Phase 1.5 Results — Internal Processing Endpoint & Event-Receipt Fencing

## 1. Executive Summary

This document records the completion of **Phase 1.5 Remediation** for the standalone Notifications microservice (`apps/notifications-service/`), resolving all three blocking gaps identified during the [`docs/NOTIFICATIONS-PHASE-1-VERIFICATION.md`](./NOTIFICATIONS-PHASE-1-VERIFICATION.md) audit:

1. **Internal Notification-Processing Endpoint Added:** Implemented `POST /v1/internal/notifications/process` protected by `internalAuthMiddleware`, bounded with safe options (`batchSize` 1–500, `baseRetryDelayMs` 100–300,000), and delegating to `notificationService.processPendingNotifications(...)`.
2. **Atomic Compare-and-Swap (CAS) Stale Recovery:** Fixed `claimEventReceipt` in `NotificationRepository` to compare against prior `claim_token` / `processed_at`, preventing concurrent workers from simultaneously reclaiming stale events.
3. **Claim Fencing on Receipt Updates:** Added a unique `claim_token` UUID to `notification_consumer_receipts` via migration `0002_consumer_receipt_fencing.sql`. Fenced `updateReceiptStatus` queries with `claim_token = $claimToken AND status = 'PROCESSING'`, ensuring delayed or zombie workers can never overwrite a newer worker's completion or failure state.

All changes were implemented strictly inside `apps/notifications-service/` and verified with 51 passing tests. The monolith remains isolated and unchanged.

---

## 2. The Three Original Blockers and How Each Was Addressed

### Blocker 1: Missing Internal Notification-Processing Endpoint

- **Issue:** Monolith interface [`INotificationClient`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-client.ts#L20-L24) requires `processPendingNotifications(options)`. The standalone service's only processing trigger was `POST /notifications/process`, which strictly required an `ADMINISTRATOR` JWT (`authMiddleware`). A monolith HTTP adapter possessed only the `INTERNAL_SERVICE_KEY`, making it impossible to implement the seam.
- **Resolution:** Added `POST /v1/internal/notifications/process` in [`apps/notifications-service/src/http/routes/internal-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/http/routes/internal-routes.ts).
  - Protected with `internalAuth` preHandler (`X-Internal-Service-Key` or `Authorization: Bearer <key>`).
  - Validates and bounds inputs: `batchSize` (integer, 1–500), `baseRetryDelayMs` (integer, 100–300,000).
  - Returns `{ claimed, sent, failed, deadLettered, processed }` matching the monolith result shape.
  - Leaves the existing administrator endpoint `POST /notifications/process` intact and fully protected.

### Blocker 2: Stale-Claim Recovery Race Condition

- **Issue:** In `claimEventReceipt`, stale recovery executed an unconditional update `WHERE consumer_name = $1 AND event_id = $2 AND status = 'PROCESSING'`. If two workers detected a stale claim simultaneously, both updates matched and succeeded (`rowCount = 1`), allowing two workers to process the same event concurrently.
- **Resolution:** Implemented an atomic Compare-and-Swap (CAS) condition in [`apps/notifications-service/src/repository/notification-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/repository/notification-repository.ts):
  ```sql
  UPDATE notification_consumer_receipts
  SET status = 'PROCESSING',
      claim_token = $3,
      processed_at = NOW()
  WHERE consumer_name = $1 AND event_id = $2
    AND status = 'PROCESSING'
    AND (
      (claim_token IS NOT NULL AND claim_token = $4)
      OR (claim_token IS NULL AND processed_at = $5)
    )
  ```
  Only the single worker matching the exact prior `claim_token` / `processed_at` succeeds in acquiring the new claim token. Competing workers get `rowCount = 0` and safely yield without executing side effects.

### Blocker 3: Stale Worker Overwriting Newer State (Fencing)

- **Issue:** `updateReceiptStatus` executed `UPDATE ... SET status = $3 WHERE consumer_name = $1 AND event_id = $2` without fencing. If Worker A was delayed beyond the stale timeout, Worker B reclaimed and completed the event (`COMPLETED`). When Worker A finished or failed, it overwrote Worker B's receipt state.
- **Resolution:** Added `claim_token VARCHAR(64)` column via migration `0002_consumer_receipt_fencing.sql`. Each claim generation generates a unique random UUID token. In `updateReceiptStatus`:
  ```sql
  UPDATE notification_consumer_receipts
  SET status = $3,
      error_metadata = $4,
      processed_at = NOW()
  WHERE consumer_name = $1
    AND event_id = $2
    AND status = 'PROCESSING'
    AND claim_token = $5
  ```
  If Worker A's claim was superseded by Worker B (which assigned a new token or transitioned status to `COMPLETED`), Worker A's update matches 0 rows and returns `false`. Worker A is strictly fenced out.

---

## 3. Files Changed and Migration Added

| File Path                                                                                                                                                                                                                                                                              | Nature of Change | Description                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`apps/notifications-service/src/infra/database/migrations/0002_consumer_receipt_fencing.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/infra/database/migrations/0002_consumer_receipt_fencing.sql) | **Created**      | Versioned migration adding `claim_token VARCHAR(64)` to `notification_consumer_receipts`.                         |
| [`apps/notifications-service/src/infra/database/migrations/runner.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/infra/database/migrations/runner.ts)                                                 | **Modified**     | Updated schema definition and runner to execute 0002 migration.                                                   |
| [`apps/notifications-service/src/domain/models.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/domain/models.ts)                                                                                       | **Modified**     | Added `claimToken?: string \| null` to `ConsumerReceiptRecord`.                                                   |
| [`apps/notifications-service/src/repository/notification-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/repository/notification-repository.ts)                                             | **Modified**     | Updated `findReceipt`, `recordReceipt`, CAS stale claim in `claimEventReceipt`, and fenced `updateReceiptStatus`. |
| [`apps/notifications-service/src/events/notification-event-consumer.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/events/notification-event-consumer.ts)                                             | **Modified**     | Propagated `claimToken` to `updateReceiptStatus` on completion and failure.                                       |
| [`apps/notifications-service/src/http/routes/internal-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/src/http/routes/internal-routes.ts)                                                           | **Modified**     | Added `POST /v1/internal/notifications/process` with input validation, bounding, and `internalAuth`.              |
| [`apps/notifications-service/test/http-api.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/test/http-api.test.ts)                                                                                     | **Modified**     | Added tests for internal process endpoint authentication, validation, and execution.                              |
| [`apps/notifications-service/test/event-consumer.test.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/notifications-service/test/event-consumer.test.ts)                                                                         | **Modified**     | Added tests for simultaneous stale claim CAS race and claim fencing against stale worker updates.                 |

---

## 4. The Claim Ownership and Fencing Mechanism

```
[Worker A: Claims Event]
   │  claim_token = "token-A", status = "PROCESSING"
   ▼
[Worker A: Encounters Delay / GC Pause (> 5 min)]
   │
   │  [Worker B: Inspects Stale Claim (age > 5 min)]
   │     │  Atomic CAS Update:
   │     │  WHERE status = 'PROCESSING' AND claim_token = 'token-A'
   │     ▼
   │  [Worker B: Reclaims Successfully]
   │     │  claim_token = "token-B", status = "PROCESSING"
   │     │  Worker B executes handleEvent(...)
   │     ▼
   │  [Worker B: Completes Event]
   │     │  Fenced Update: WHERE claim_token = 'token-B' AND status = 'PROCESSING'
   │     ▼  status = "COMPLETED"
   │
[Worker A: Wakes Up Late & Attempts to Record Failure]
   │
   ▼  Fenced Update:
      UPDATE ... SET status = 'FAILED'
      WHERE claim_token = 'token-A' AND status = 'PROCESSING'
   │
   ▼  [MATCHES 0 ROWS!]
   └──> Worker A's update is REJECTED.
        Receipt remains "COMPLETED" with "token-B".
```

### Guarantees Achieved

- **CAS Stale Recovery:** Only a single worker can succeed in reclaiming a stale receipt when multiple workers compete.
- **Terminal State Inviolability:** Once an event transitions to `COMPLETED`, no delayed or stale worker can overwrite it with `FAILED` or `PROCESSING`.
- **Active Claim Segregation:** Even if Worker B is still processing when Worker A wakes up, Worker A cannot overwrite Worker B's error state because `token-A != token-B`.

---

## 5. Test Commands and Actual Results

### Standalone Notifications Service Tests

- **Command:** `npm test`
- **Result:** **All 51 tests passed across 6 test files** (increased from 45 tests):
  - `test/auth-boundary.test.ts` (6 passed)
  - `test/channel-provider.test.ts` (4 passed)
  - `test/notification-repository.test.ts` (5 passed)
  - `test/notification-service.test.ts` (9 passed)
  - `test/event-consumer.test.ts` (12 passed — includes CAS race and fencing tests)
  - `test/http-api.test.ts` (15 passed — includes internal process endpoint tests)

### TypeScript Typecheck & Build

- **Commands:** `npm run typecheck`, `npm run build`
- **Result:** **0 errors**. Clean compilation with `exactOptionalPropertyTypes: true`.

### Monolith Seam Regression Test

- **Command:** `npm test -- test/notification-client.test.ts`
- **Result:** **All 6 tests passed** in `apps/api`.

---

## 6. Verification Against `INotificationClient` Contract

| `INotificationClient` Monolith Method                                                                                                                                        | Target Standalone HTTP Route                          | Authentication Mechanism                                   | Status    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto>`                                                                                       | `POST /v1/internal/notifications/request`             | `X-Internal-Service-Key` (constant-time timing-safe equal) | **READY** |
| `sendTransactionalEmail(to: string, subject: string, body: string): Promise<string>`                                                                                         | `POST /v1/internal/notifications/transactional-email` | `X-Internal-Service-Key` (constant-time timing-safe equal) | **READY** |
| `processPendingNotifications(options?: { batchSize?: number; baseRetryDelayMs?: number }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }>` | `POST /v1/internal/notifications/process`             | `X-Internal-Service-Key` (constant-time timing-safe equal) | **READY** |

---

## 7. Residual Risks and Delivery Guarantees

1. **At-Least-Once Delivery Guarantee:**
   As with any distributed system, if a worker dispatches an email through an external provider (e.g. Resend) and crashes before committing the `COMPLETED` receipt update, the redelivered event may cause a duplicate delivery attempt. However, within the notification service, `requestNotification` uses the unique `idempotency_key` constraint on `notifications`, preventing duplicate notifications from being enqueued.
2. **Autonomous Background Worker in Standalone Service:**
   While the HTTP endpoint `POST /v1/internal/notifications/process` now exists and matches the monolith seam, the standalone service still does not run its own in-process background timer by default. This is intentional: during the strangler migration, the monolith's existing background interval will call the standalone service's internal endpoint via `HttpNotificationClient`.

---

## 8. Conclusion and Next Step

All three blockers from the Phase 1 verification audit are **completely resolved and verified**.

The standalone service is now **100% READY FOR HTTP ADAPTER INTEGRATION**.

**Recommended Next Step:**
Implement `HttpNotificationClient` in `apps/api/src/modules/notifications/internal/http-notification-client.ts` as a feature-flagged adapter implementing `INotificationClient`, accompanied by focused unit tests with mocked HTTP responses.
