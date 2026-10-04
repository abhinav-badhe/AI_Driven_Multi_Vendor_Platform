# ADR 0020: Durable Events Infrastructure and Notifications Architecture

## Status
Accepted

## Context
Phase 10 introduces the platform's durable event infrastructure and notification capability while preserving all existing bounded-context ownership and transactional invariants established in Phases 1–9.

### Key Architectural Invariants & Challenges
1. **Core Principle: Transactional Outbox Pattern**:
   A business state change and its corresponding domain event must commit atomically within the same PostgreSQL transaction (`UPDATE authoritative_domain_table ... INSERT INTO outbox_events ... COMMIT`). Emitting events after the business transaction commits creates a catastrophic event-loss window upon system crash or network failure.
2. **Event Ownership**:
   The bounded context that owns a business fact owns the event describing that fact:
   - Catalog owns `catalog.product.*`
   - Marketplace owns `marketplace.listing.*`
   - Orders owns `order.created`, `order.status_changed`
   - Payment owns `payment.succeeded`, `payment.failed`, `payment.refund_created`
   - Fulfillment owns `fulfillment.shipment.*`, `fulfillment.return.*`
   - Settlement owns `settlement.status_changed`
   Event consumers (e.g. Search, Notifications) react to facts; they do not own or redefine them.
3. **Delivery Semantics & Idempotency**:
   Message delivery follows **at-least-once** semantics. Therefore, consumers MUST be idempotent. To survive worker restarts and multi-replica concurrency, deduplication must be durable in the database (`event_consumer_receipts` table with `UNIQUE(consumer_name, event_id)`).
4. **Transport Abstraction**:
   Application logic must remain provider-neutral (`EventTransport` abstraction) without permanent compile-time coupling to Kafka, RabbitMQ, SQS, or Pub/Sub. A deterministic in-memory adapter is provided for testing and development.
5. **Notification Capability**:
   Notifications is a separate bounded capability owning notification requests, delivery status, channel abstractions (Email, SMS, Push), retry state, and template selection. It does NOT own order, payment, or customer truth. It enforces durable idempotency via `UNIQUE(idempotency_key)`.

---

## Decisions

### 1. Transactional Outbox Schema & Atomicity (`outbox_events`)
The `outbox_events` table contains:
* `event_id` (VARCHAR(64) PRIMARY KEY, globally unique UUIDv4)
* `event_type` (VARCHAR(128) NOT NULL)
* `event_version` (INTEGER NOT NULL DEFAULT 1)
* `aggregate_type` (VARCHAR(64) NOT NULL)
* `aggregate_id` (VARCHAR(64) NOT NULL)
* `tenant_id` (VARCHAR(36) NOT NULL)
* `occurred_at` (TIMESTAMPTZ NOT NULL)
* `payload` (JSONB NOT NULL, versioned, structured, PII/secret-sanitized)
* `metadata` (JSONB NOT NULL, correlationId, causationId, actorId, source)
* `status` (VARCHAR(32) NOT NULL DEFAULT 'PENDING')
* `attempt_count` (INTEGER NOT NULL DEFAULT 0)
* `available_at` (TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
* `lease_expires_at` (TIMESTAMPTZ)
* `published_at` (TIMESTAMPTZ)
* `last_error` (TEXT)

The `OutboxService.recordEvent(tx, event)` API mandates that the caller provide the active database transaction `tx`. If the business mutation rolls back, the outbox record rolls back. If the outbox insert fails (e.g. duplicate event ID), the business mutation rolls back.

### 2. Standardized Event Envelope & Versioning Contract
All events conform to the typed `DomainEvent<TPayload>` contract:
```typescript
export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  occurredAt: string;
  payload: TPayload;
  metadata: {
    correlationId?: string;
    causationId?: string;
    actorId?: string;
    source?: string;
  };
}
```
Event types use explicit dot-notation versions (e.g. `catalog.product.created.v1`, `order.created.v1`). Event consumers declare their supported versions (`supportedVersions: Set<number>`). Unsupported versions are quarantined into `event_consumer_receipts` with status `QUARANTINED` rather than silently executed.

### 3. Outbox Dispatcher, Lease Recovery & Concurrency Control
The `OutboxService.publishPendingEvents()` dispatcher selects eligible pending records or records stranded in `PROCESSING` whose `lease_expires_at` has elapsed.
To ensure safety across multiple concurrent publisher replicas:
- Candidate records are updated conditionally:
  `UPDATE outbox_events SET status = 'PROCESSING', lease_expires_at = $1 WHERE event_id = $2 AND (status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at < NOW()))`
- Only rows returning `rowCount > 0` are claimed by that worker.
- Exponential backoff is applied on failure (`attempt_count * baseDelay`).
- Events exceeding `maxAttempts` are permanently moved to `DEAD_LETTERED`.

### 4. Consumer Idempotency (`event_consumer_receipts`)
The `BaseEventConsumer` provides a resilient idempotency wrapper:
1. Checks for an existing receipt in `event_consumer_receipts`. If already `COMPLETED` or `SKIPPED`, the delivery is acknowledged immediately with zero duplicate side effects.
2. If new, inserts an initial receipt with `status = 'PROCESSING'`. If a concurrent duplicate delivery collides, the PostgreSQL `UNIQUE(consumer_name, event_id)` constraint throws a unique constraint error, allowing sibling workers to safely back off.
3. Invokes the domain handler `handleEvent(event)`.
4. Marks the receipt as `COMPLETED`.
5. On unhandled failure, marks the receipt as `FAILED` with serialized error details.

### 5. Search Consumer Integration
Phase 10 connects Catalog and Marketplace events to the Phase 9 `SearchService`:
- `catalog.product.created.v1` & `catalog.product.updated.v1` invoke `SearchService.upsertProductProjection(...)`
- `catalog.product.archived.v1` invokes `SearchService.removeProductProjection(...)`
- `marketplace.listing.created.v1` & `marketplace.listing.updated.v1` invoke `SearchService.upsertListingProjection(...)`
- `marketplace.listing.deactivated.v1` invokes `SearchService.removeListingProjection(...)`
Out-of-order deliveries are rejected cleanly by `SearchService`'s monotonic `sourceVersion` protection.

### 6. Notifications Bounded Context
- Bounded Context: `notifications`
- Providers: Provider-neutral channel abstractions (`EmailChannelProvider`, `SmsChannelProvider`, `PushChannelProvider`).
- Deduplication: Deterministic idempotency key `${eventId}:${notificationType}:${recipient}:${channel}` stored in `notifications.idempotency_key` with a database `UNIQUE` constraint. Duplicate requests return the existing record without dispatching duplicate messages.
- Customer Preferences: Verified through `customer_notification_preferences` (`email_enabled`, `sms_enabled`, `push_enabled`, `disabled_types`). If a customer opts out, the notification is skipped without errors.
- Isolation: Bounded retry, tenant isolation on all queries, administrative endpoints protected by RBAC (`events:read`, `events:manage`, `notifications:read`, `notifications:manage`).

---

## Consequences
- **Positive**:
  - Atomic transactions prevent outbox event loss.
  - At-least-once delivery with durable receipts eliminates duplicate consumer side effects across process restarts.
  - Monotonic version check prevents stale search projections.
  - Extensible channel abstractions allow seamless integration of future transport brokers (Kafka/RabbitMQ) and notification providers (SES/SendGrid/Twilio).
- **Negative / Operational Considerations**:
  - Requires scheduled outbox publishing background processes or worker loops.
  - Requires periodic cleanup or archiving of historical outbox events and consumer receipts.
