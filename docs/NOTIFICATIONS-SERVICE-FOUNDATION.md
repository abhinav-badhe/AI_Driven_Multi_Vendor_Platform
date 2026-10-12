# Notifications Service Foundation Architecture

## 1. Overview & Strangler Migration Status

As the first business domain microservice to be extracted from the modular monolith, the **Notifications Service** has been established as an independent, standalone TypeScript/Fastify service under `apps/notifications-service/`.

Following the approved strangler migration strategy:

- The standalone service structure and isolated persistence layer have been created.
- The service defines its own domain entities, repository, channel providers, event consumer boundaries, configuration, and HTTP APIs.
- **Zero Monolith Runtime Changes:** The monolith continues to run against `LocalNotificationClient` within its modular boundary. No HTTP calls or gateway routes link the monolith to `apps/notifications-service` during this initial phase.
- **Zero Database Changes to Monolith:** Neither `commerce_db` nor `commerce_db_backup` were touched, modified, or migrated. No database migrations were executed against PostgreSQL.

```
+-------------------------------------------------------------------------+
|                           MODULAR MONOLITH                              |
|                                                                         |
|  Orders / Payments / Shipping / Price Alerts                            |
|             |                                                           |
|             v                                                           |
|     INotificationClient  (Monolith Seam)                                |
|             |                                                           |
|             +--> LocalNotificationClient (ACTIVE IN MONOLITH)           |
|             |                                                           |
|             +--> [Future: HttpNotificationClient]                       |
+-------------------------------------------------------------------------+
                                 | (Future HTTP / Broker)
                                 v
+-------------------------------------------------------------------------+
|                  apps/notifications-service (STANDALONE)                |
|                                                                         |
|  HTTP API Layer:                                                        |
|    - Health: GET /health, GET /ready                                    |
|    - Internal: POST /v1/internal/notifications/request                  |
|                POST /v1/internal/notifications/transactional-email      |
|    - Admin:    GET /notifications, GET /notifications/:id               |
|                POST /notifications/:id/retry, POST /notifications/process|
|    - Customer: GET /customers/me/notification-preferences               |
|                PUT /customers/me/notification-preferences               |
|                                                                         |
|  Domain Engine (NotificationService):                                   |
|    - Customer channel preference suppression                            |
|    - Deterministic request deduplication (idempotency)                  |
|    - Claiming lifecycle, exponential backoff, dead-letter quarantine    |
|                                                                         |
|  Event Consumer Boundary (NotificationEventConsumer):                   |
|    - Ingestion of order, payment, shipment, return, settlement events   |
|    - Idempotency via notification_consumer_receipts                     |
|                                                                         |
|  Channel Providers:                                                     |
|    - EmailChannelProvider (ResendEmailProvider / InMemoryEmailProvider) |
|    - SmsChannelProvider / PushChannelProvider                           |
|                                                                         |
|  Isolated Persistence (Service-Owned Tables Only):                      |
|    - notifications                                                      |
|    - customer_notification_preferences                                  |
|    - notification_consumer_receipts                                     |
+-------------------------------------------------------------------------+
```

---

## 2. Service Responsibility Boundary

### What the Notifications Service Owns:

- Notification request acceptance, idempotency validation, and persistence.
- Complete lifecycle management: `PENDING` -> `PROCESSING` -> `SENT` | `RETRY_SCHEDULED` | `DEAD_LETTERED` | `SKIPPED`.
- Exponential backoff calculation and delivery retry scheduling.
- Channel delivery abstractions for Email (Resend), SMS, and Push.
- Customer notification preferences (opt-in/opt-out per channel and notification type).
- Consumer receipt tracking for idempotent domain event ingestion.
- Platform administration inspection and manual retry endpoints.
- High-priority transactional email delivery.

### What the Notifications Service Does NOT Own:

- **Price Alerts Business Logic:** Remains strictly inside the monolith (`apps/api/src/modules/price-alerts`). Price alerts determine _when_ an alert condition is triggered and _delegates_ the sending through `INotificationClient`.
- **Identity & User Truth:** Does not manage user credentials, passwords, or tenant memberships.
- **Commerce Entities:** Has zero ownership or knowledge of catalog products, skus, inventory reservations, orders, checkout carts, payments, or shipments.
- **ML & Analytics:** Has zero ML models, embeddings, or inference pipelines.

---

## 3. Service-Owned Data & Persistence Isolation

The service defines its own DDL migration under `apps/notifications-service/src/infra/database/migrations/0001_notifications_service_schema.sql`.

### Owned Tables:

1. **`notifications`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `tenant_id VARCHAR(64) NOT NULL` (identifier only; no foreign key)
   - `event_id VARCHAR(128) NOT NULL`
   - `notification_type VARCHAR(64) NOT NULL`
   - `channel VARCHAR(16) NOT NULL` (`EMAIL`, `SMS`, `PUSH`)
   - `recipient VARCHAR(255) NOT NULL`
   - `idempotency_key VARCHAR(255) NOT NULL UNIQUE`
   - `template_id VARCHAR(128) NOT NULL`
   - `payload JSONB NOT NULL DEFAULT '{}'`
   - `status VARCHAR(32) NOT NULL DEFAULT 'PENDING'`
   - `attempt_count INT NOT NULL DEFAULT 0`
   - `max_attempts INT NOT NULL DEFAULT 3`
   - `available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `sent_at TIMESTAMPTZ`
   - `last_error TEXT`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

2. **`customer_notification_preferences`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `tenant_id VARCHAR(64) NOT NULL`
   - `customer_id VARCHAR(64) NOT NULL`
   - `email_enabled BOOLEAN NOT NULL DEFAULT TRUE`
   - `sms_enabled BOOLEAN NOT NULL DEFAULT TRUE`
   - `push_enabled BOOLEAN NOT NULL DEFAULT TRUE`
   - `disabled_types TEXT NOT NULL DEFAULT ''` (comma-delimited)
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `CONSTRAINT uq_customer_pref UNIQUE(tenant_id, customer_id)`

3. **`notification_consumer_receipts`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `consumer_name VARCHAR(128) NOT NULL`
   - `event_id VARCHAR(128) NOT NULL`
   - `status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED'`
   - `error_metadata JSONB`
   - `processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `CONSTRAINT uq_notif_consumer_receipt UNIQUE(consumer_name, event_id)`

### Strict Isolation Invariant:

The standalone repository queries **only** these three tables. It contains zero joins or foreign keys to `users`, `products`, `orders`, `inventory_items`, or `payments`. Integration tests (`test/notification-repository.test.ts`) assert that querying any foreign table results in database errors while service-owned operations run with 100% independence.

---

## 4. HTTP APIs

### Public & Health Endpoints

- `GET /health` -> `{ status: 'ok', service: 'notifications-service', timestamp: string }`
- `GET /ready` -> `{ status: 'ready', service: 'notifications-service', database: 'connected', timestamp: string }`

### Internal Inter-Service Endpoints (Future `HttpNotificationClient` Target)

- `POST /v1/internal/notifications/request`
  - Body: `{ tenantId, customerId?, eventId?, notificationType, channel, recipient, templateId?, payload, idempotencyKey? }`
  - Returns: `NotificationResultDto`
- `POST /v1/internal/notifications/transactional-email`
  - Body: `{ tenantId, recipient, subject, body, templateId?, metadata?, idempotencyKey? }`
  - Returns: `NotificationResultDto`

### Administration APIs (Role: `ADMINISTRATOR`)

- `GET /notifications?tenantId=&status=&channel=&limit=&offset=`
  - Returns paginated list of notification records.
- `GET /notifications/:id`
  - Returns notification detail record.
- `POST /notifications/:id/retry`
  - Resets a `FAILED` or `DEAD_LETTERED` notification back to `PENDING` with `attempt_count = 0`.
- `POST /notifications/process`
  - Triggers background batch dispatch of `PENDING` notifications.

### Customer Preference APIs (Role: `CUSTOMER` / Authenticated Actor)

- `GET /customers/me/notification-preferences`
  - Returns customer channel preferences.
- `PUT /customers/me/notification-preferences`
  - Body: `{ emailEnabled?, smsEnabled?, pushEnabled?, disabledTypes? }`
  - Updates customer channel preferences.

---

## 5. Authentication Boundary

- The Notifications Service does not possess direct access to the `users` or `tenant_memberships` tables.
- Authentication is verified cryptographically via `HmacTokenVerifier` (`apps/notifications-service/src/auth/token-verifier.ts`), which independently parses and validates the existing token signature issued by the monolith Identity service:
  $$\text{signature} = \text{SHA256}(\text{header}.\text{payload}.\text{JWT\_SECRET})$$
- Verified claims:
  - `sub` -> `actor.userId`
  - `tid` -> `actor.tenantId`
  - `rol` -> `actor.role` (`ADMINISTRATOR` | `MERCHANT` | `CUSTOMER`)
  - `exp` -> Token expiration timestamp validation
- Fastify preHandler middleware (`apps/notifications-service/src/auth/auth-middleware.ts`) extracts the `Bearer` token and attaches `request.actor`.

---

## 6. Channel Provider Boundary

Channel delivery logic is isolated behind strict provider interfaces in `apps/notifications-service/src/channels/channel-provider.ts`:

- `EmailChannelProvider`:
  - `ResendEmailProvider`: Direct integration with Resend API (`https://api.resend.com/emails`) using native `fetch`.
  - `InMemoryEmailProvider`: For tests and local execution without credentials.
- `SmsChannelProvider`: `InMemorySmsProvider`.
- `PushChannelProvider`: `InMemoryPushProvider`.

All provider specific logic is quarantined behind these interfaces; business logic never invokes third-party SDKs directly.

---

## 7. Event Consumer Boundary

The event consumption boundary is established in `apps/notifications-service/src/events/notification-event-consumer.ts`.
Supported domain events:

1. `order.created.v1` -> Generates `ORDER_CONFIRMATION` notification.
2. `payment.succeeded.v1` -> Generates `PAYMENT_RECEIPT` notification.
3. `payment.failed.v1` -> Generates `PAYMENT_FAILURE_ALERT` notification.
4. `fulfillment.shipment_status_changed.v1` -> Generates `SHIPMENT_STATUS_UPDATE` notification.
5. `fulfillment.return_status_changed.v1` -> Generates `RETURN_STATUS_UPDATE` notification.
6. `settlement.status_changed.v1` -> Generates `SETTLEMENT_UPDATE` notification.

Every incoming event is processed idempotently by recording receipts in `notification_consumer_receipts`. Redelivered events are recognized and dropped cleanly.

---

## 8. What is Intentionally NOT Connected Yet

1. **Monolith Client Seam:** The monolith continues using `LocalNotificationClient`. `HttpNotificationClient` is not implemented in this phase.
2. **Event Broker:** No physical broker (Redis Streams, RabbitMQ, Kafka, or SQS) is introduced yet.
3. **Database Migration:** Migrations are written as service artifacts (`0001_notifications_service_schema.sql`) and validated against in-memory tests, but not executed against the production PostgreSQL server.
4. **API Gateway / Ingress:** No routing proxy is pointed to `notifications-service` port yet.

---

## 9. Future Integration Points

1. **Monolith Cutover (`HttpNotificationClient`):**
   - Implement `HttpNotificationClient` implementing `INotificationClient` in `apps/api`.
   - Configure with `NOTIFICATIONS_SERVICE_URL`.
   - Point internal calls from `PriceAlertService`, `BackInStockService`, etc. through HTTP.
2. **Event Broker Cutover:**
   - Implement external message transport subscription (e.g. Redis Stream consumer or Kafka consumer) delivering `DomainEvent` envelopes into `NotificationEventConsumer.process(event)`.
