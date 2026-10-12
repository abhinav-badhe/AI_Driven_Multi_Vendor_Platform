# EXTRACTION BOUNDARY ANALYSIS: NOTIFICATIONS & PRICE ALERTS

> **Document Status:** Authoritative Read-Only Microservices Extraction Assessment  
> **Extraction Candidate Under Evaluation:** Notifications & Price Alerts  
> **Phase:** Monolith → Distributed Microservices Architecture (Migration Step 1 Analysis)  
> **Constraint Verification:** READ-ONLY ANALYSIS. Zero source code modified, zero databases or schemas changed, zero infrastructure provisioned, zero servers started, zero commits made.  
> **Codebase Target:** Fastify modular monolith (`apps/api`), React frontend (`apps/web`), PostgreSQL migrations (`apps/api/src/infra/database/migrations/`).

---

## 1. Executive Summary

This document presents a comprehensive, empirical, read-only extraction boundary analysis to determine whether **Notifications** and **Price Alerts** constitute a safe first non-ML microservice extraction candidate from the modular monolith.

### Key Finding & Verdict

- **Notifications alone** is an **exceptionally clean, decoupled candidate** for standalone microservice extraction. It possesses an isolated persistence model (2 tables with zero foreign keys to other domains), acts as a pure downstream event consumer and channel dispatcher, and contains zero outbound queries into foreign business domains.
- **Price Alerts**, by contrast, is **currently heavily entangled** with the monolith's core database. Its repository performs raw SQL joins and queries across **seven (7) foreign domain tables** (`products`, `product_skus`, `merchant_listings`, `inventory_items`, `tenant_memberships`, `users`, and `ml_predictions`). Furthermore, it is invoked **synchronously inside the monolith HTTP handler** for listing updates (`listing-routes.ts`).
- **Extraction Topology Decision:** **OPTION B — EXTRACT SEPARATELY (STAGED EXTRACTION)**. Notifications must be extracted first as an independent, lightweight notification delivery microservice. Price Alerts must **not** be bundled into the initial notification service; bundling them would contaminate the new service with catalog, inventory, pricing, identity, and ML dependencies. Price Alerts should remain in the monolith until its cross-table SQL queries are refactored into domain event subscriptions or domain API queries.
- **Final Readiness Verdict:** **EXTRACTION READY WITH PREREQUISITES** (for Notifications Service extraction).

---

## 2. Notifications Module: Deep Implementation Audit

### 2.1 File Structure & Locations

- **Module Interface:** [`apps/api/src/modules/notifications/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/index.ts)
- **Domain Service:** [`apps/api/src/modules/notifications/internal/notification-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-service.ts)
- **Repository:** [`apps/api/src/modules/notifications/internal/notification-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-repository.ts)
- **Domain Models & Types:** [`apps/api/src/modules/notifications/internal/notification-models.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-models.ts)
- **Event Consumer:** [`apps/api/src/modules/notifications/internal/notification-consumer.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-consumer.ts)
- **Channel Dispatch Providers:** [`apps/api/src/modules/notifications/internal/channel-providers.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/channel-providers.ts)
- **HTTP Route Controller:** [`apps/api/src/http/event-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/event-routes.ts#L92-L215)
- **Database Migration:** [`apps/api/src/infra/database/migrations/0009_events_and_notifications_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0009_events_and_notifications_schema.sql)

### 2.2 Core Responsibilities & Workflow

1. **Request Intake:** `NotificationService.requestNotification(...)` validates input fields, checks customer notification opt-outs (email, SMS, push, notification types), generates a deterministic idempotency key (`${eventId}:${notificationType}:${recipient}:${channel}`), and inserts the notification into the database in `PENDING` state.
2. **Channel Dispatch & Polling:** `NotificationService.processPendingNotifications(...)` claims up to `batchSize` notifications atomically in a transaction (`status = 'PROCESSING'`), invokes channel providers (`ResendEmailProvider`, `InMemoryEmailProvider`, `InMemorySmsProvider`, `InMemoryPushProvider`), updates `status = 'SENT'` on success, or applies exponential backoff / dead-lettering (`status = 'RETRY_SCHEDULED'` or `'DEAD_LETTERED'`).
3. **Account Security Email Hook:** `NotificationService.sendTransactionalEmail(to, subject, body)` dispatches verification or password emails immediately via `emailProvider.sendEmail(...)`, intentionally bypassing marketing preference checks.
4. **Preference Governance:** `setCustomerPreferences` and `getCustomerPreferences` allow customers to toggle email, SMS, push notifications, and disable specific notification types.
5. **Admin Monitoring:** Administrative endpoints to list, inspect, manually retry failed notifications, and trigger batch processing.

### 2.3 Dependencies on Other Modules & Shared Infrastructure

- **Inbound Domain Dependencies:**
  - `PriceAlertService`: invokes `requestNotification` for price drops.
  - `BackInStockService`: invokes `requestNotification` for back-in-stock notifications and calls `processPendingNotifications()`.
  - `IdentityService`: calls `sendTransactionalEmail` for user registration email verification.
  - `NotificationEventConsumer`: consumes events published by Orders, Payments, Fulfillment, and Settlement contexts.
  - Background loop (`app.ts` line 594): calls `processPendingNotifications()` on a 30-second interval.
- **Outbound Domain Dependencies:**
  - **ZERO.** Notifications module does not import or invoke any service from Catalog, Cart, Checkout, Customer, Fulfillment, Inventory, Marketplace, Orders, Payments, Recommendations, or Settlement.
- **Shared Infrastructure Dependencies:**
  - `DatabaseConnection`: shared PostgreSQL client connection.
  - `Logger`: shared `JsonLogger`.
  - `EventTransport`: shared in-process `EventEmitter`.
  - External Resend HTTP API (`https://api.resend.com/emails`).

---

## 3. Price Alerts Module: Deep Implementation Audit

### 3.1 File Structure & Locations

- **Module Interface:** [`apps/api/src/modules/price-alerts/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/index.ts)
- **Domain Service:** [`apps/api/src/modules/price-alerts/internal/price-alert-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/internal/price-alert-service.ts)
- **Repository:** [`apps/api/src/modules/price-alerts/internal/price-alert-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/internal/price-alert-repository.ts)
- **HTTP Route Controller:** [`apps/api/src/http/price-alert-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/price-alert-routes.ts)
- **Database Migration:** [`apps/api/src/infra/database/migrations/0018_price_watches_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0018_price_watches_schema.sql)

### 3.2 Core Responsibilities & Workflow

1. **View Tracking:** Customers browsing a product record a view signal via `POST /products/:id/views`, inserting/upserting a row in `product_price_watches` with `customer_tenant_id`, `product_id`, `last_seen_price`, and `last_seen_currency`.
2. **Synchronous Listing Update Evaluation:** When a merchant updates listing price via `PUT/PATCH /listings/:id` ([`apps/api/src/http/listing-routes.ts#L154-L156`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/listing-routes.ts#L154-L156)), the HTTP handler directly and synchronously invokes `priceAlertService.checkListing(id)`.
3. **Price Drop Detection:** `checkProduct(productId)` finds the current lowest in-stock listing price across all active merchant listings, queries watched candidates whose last seen price exceeds current price by >1%, pulls product details and ML demand forecast, formats an email message, and delegates to `notificationService.requestNotification(...)`.
4. **Admin Sweep:** `POST /price-alerts/sweep` executes `sweepAll(sinceDays = 90)` across all active watched products to catch drops that might have bypassed listing updates.
5. **Customer Management:** `GET /price-alerts/mine` lists all products the authenticated customer is watching; `DELETE /price-alerts/watches/:productId` sets `unsubscribed = true`.

### 3.3 Dependencies on Other Modules & Shared Infrastructure

- **Inbound Domain Dependencies:**
  - `listing-routes.ts`: synchronous in-process invocation during merchant listing update.
  - HTTP routes: customer product page views and account management.
- **Outbound Domain Dependencies (CRITICAL ENTANGLEMENT):**
  - **Notifications:** Hard dependency on `NotificationService` injected into constructor.
  - **Catalog:** Direct SQL queries on `products` (title, brand, thumbnail) and `product_skus`.
  - **Merchant / Marketplace:** Direct SQL query on `merchant_listings`.
  - **Inventory:** Direct SQL query on `inventory_items` (calculates `on_hand - reserved - non_sellable > 0`).
  - **Identity:** Direct SQL joins on `tenant_memberships`, `users` (to fetch verified emails for `customer_tenant_id`), and foreign keys to `tenants(id)`.
  - **Analytics-ML:** Direct SQL query on `ml_predictions` (reads `DEMAND_FORECASTING` for the product).
- **Shared Infrastructure Dependencies:**
  - `DatabaseConnection`, `Logger`, and `frontendUrl`.

---

## 4. Inbound & Outbound Dependency Map

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     MONOLITH DOMAINS                                        │
│                                                                                             │
│  [Identity]       [Orders]      [Payments]    [Fulfillment]   [Settlement]   [Customer/BIS] │
│     │                │              │               │               │              │        │
│     │ (sendEmail)    │              │               │               │              │        │
│     ▼                ▼              ▼               ▼               ▼              ▼        │
│  ┌──────────────────────────────────────────────────────────────────────────────┐           │
│  │                     Transactional Outbox / Event Relay                       │           │
│  └──────────────────────────────────────┬───────────────────────────────────────┘           │
│                                         │                                                   │
│                                         ▼ (In-process Domain Events)                        │
│                           ┌───────────────────────────┐                                     │
│                           │ NotificationEventConsumer │                                     │
│                           └─────────────┬─────────────┘                                     │
│                                         │                                                   │
│  [Merchant Listings]                    │ (requestNotification)                             │
│     │ (PUT /listings/:id)               │                                                   │
│     ▼                                   ▼                                                   │
│  ┌────────────────────┐               ┌────────────────────────────────────────┐            │
│  │ PriceAlertService  │──────────────▶│          NotificationService           │            │
│  └────────┬───────────┘               └───────────────────┬────────────────────┘            │
│           │                                               │                                 │
│           │ (Raw SQL Queries)                             │ (Dispatch)                      │
│           ▼                                               ▼                                 │
│  ┌──────────────────────────────┐             ┌───────────────────────────────────┐         │
│  │ 7 Monolith DB Tables:        │             │ External Provider:                │         │
│  │ - products                   │             │ - Resend Email API                │         │
│  │ - product_skus               │             │ - InMemory Mock Providers         │         │
│  │ - merchant_listings          │             └───────────────────────────────────┘         │
│  │ - inventory_items            │                                                           │
│  │ - tenant_memberships         │                                                           │
│  │ - users                      │                                                           │
│  │ - ml_predictions             │                                                           │
│  └──────────────────────────────┘                                                           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Inbound Summary Table

| Target Module     | Inbound Caller              | Calling Mechanism                      | Shared Transaction?             |
| :---------------- | :-------------------------- | :------------------------------------- | :------------------------------ |
| **Notifications** | `PriceAlertService`         | In-process constructor injection       | No (separate query)             |
| **Notifications** | `BackInStockService`        | In-process constructor injection       | No (explicitly outside TX)      |
| **Notifications** | `IdentityService`           | In-process function hook (`sendEmail`) | No (direct API call)            |
| **Notifications** | `NotificationEventConsumer` | In-process event subscription          | No (runs inside receipt TX)     |
| **Notifications** | `event-routes.ts`           | Fastify HTTP handlers                  | No                              |
| **Notifications** | Monolith timer (`app.ts`)   | Periodic `setInterval` (30s)           | Yes (isolated batch TX)         |
| **Price Alerts**  | `listing-routes.ts`         | In-process service call                | No (after listing TX completes) |
| **Price Alerts**  | `price-alert-routes.ts`     | Fastify HTTP handlers                  | No                              |

### Outbound Summary Table

| Source Module     | Outbound Target            | Nature of Call      | Impact / Coupling Severity               |
| :---------------- | :------------------------- | :------------------ | :--------------------------------------- |
| **Notifications** | Resend API                 | External HTTPS POST | **LOW**: Standard 3rd-party provider     |
| **Notifications** | Monolith Tables            | **NONE**            | **ZERO**: 100% self-contained            |
| **Price Alerts**  | `NotificationService`      | In-process call     | **LOW**: Can become HTTP/event           |
| **Price Alerts**  | `products` table           | Raw SQL SELECT      | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `product_skus` table       | Raw SQL SELECT      | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `merchant_listings` table  | Raw SQL SELECT      | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `inventory_items` table    | Raw SQL SELECT      | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `tenant_memberships` table | Raw SQL JOIN        | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `users` table              | Raw SQL JOIN        | **CRITICAL**: Cross-domain database read |
| **Price Alerts**  | `ml_predictions` table     | Raw SQL SELECT      | **HIGH**: Cross-domain database read     |

---

## 5. Database Ownership Analysis

### 5.1 Tables Used by Notifications

1. **`notifications`**
   - **Schema Origin:** Migration `0009_events_and_notifications_schema.sql` (lines 67–88).
   - **Columns:** `id`, `tenant_id`, `event_id`, `notification_type`, `channel`, `recipient`, `idempotency_key`, `template_id`, `payload`, `status`, `attempt_count`, `max_attempts`, `available_at`, `sent_at`, `last_error`, `created_at`, `updated_at`.
   - **Foreign Keys:** **NONE.** (`tenant_id` and `event_id` are unconstrained `VARCHAR`).
   - **Who Reads:** `NotificationRepository` exclusively (`listNotifications`, `claimPendingNotifications`, `getNotificationById`, `findNotificationByIdempotencyKey`).
   - **Who Writes:** `NotificationRepository` exclusively (`insertNotification`, `markSent`, `recordFailure`, `retryNotification`).
   - **Direct Cross-Module DB Access:** **NONE.**
   - **Ownership Assessment:** **100% SERVICE-OWNED CANDIDATE.**

2. **`customer_notification_preferences`**
   - **Schema Origin:** Migration `0009_events_and_notifications_schema.sql` (lines 51–62).
   - **Columns:** `id`, `tenant_id`, `customer_id`, `email_enabled`, `sms_enabled`, `push_enabled`, `disabled_types`, `created_at`, `updated_at`.
   - **Foreign Keys:** **NONE.** (`tenant_id` and `customer_id` are unconstrained `VARCHAR`).
   - **Who Reads:** `NotificationRepository.findCustomerPreferences` exclusively.
   - **Who Writes:** `NotificationRepository.upsertCustomerPreferences` exclusively.
   - **Direct Cross-Module DB Access:** **NONE.**
   - **Ownership Assessment:** **100% SERVICE-OWNED CANDIDATE.**

### 5.2 Tables Used by Price Alerts

3. **`product_price_watches`**
   - **Schema Origin:** Migration `0018_price_watches_schema.sql` (lines 5–17).
   - **Columns:** `id`, `customer_tenant_id`, `product_id`, `last_seen_price`, `last_seen_currency`, `last_alerted_price`, `alert_count`, `unsubscribed`, `created_at`, `updated_at`.
   - **Foreign Keys:**
     - `REFERENCES tenants(id) ON DELETE CASCADE`
     - `REFERENCES products(id) ON DELETE CASCADE`
   - **Who Reads:** `PriceAlertRepository` (`listWatchesForCustomer`, `findAlertCandidates`, `distinctWatchedProductIds`).
   - **Who Writes:** `PriceAlertRepository` (`recordView`, `setUnsubscribed`, `markAlerted`).
   - **Direct Cross-Module DB Access:** No other module queries `product_price_watches`.
   - **Foreign Key / Distributed Risk:** Contains direct relational foreign keys to `tenants` and `products`. If moved to an isolated database, these foreign key constraints must be dropped in favor of logical ID references and asynchronous cleanup events.

4. **Foreign Tables Read by Price Alerts (ENTANGLEMENT LIST):**
   - **`products`** (Catalog): queried for existence (`productExists`) and metadata (`productBasics`).
   - **`product_skus`** (Catalog): queried to resolve `listing.sku_id -> sku.product_id`.
   - **`merchant_listings`** (Marketplace): queried to find floor prices and resolve listing price drops.
   - **`inventory_items`** (Inventory): joined to check sellable stock (`on_hand - reserved - non_sellable > 0`).
   - **`tenant_memberships`** (Identity): joined to find user IDs for customer tenant IDs.
   - **`users`** (Identity): joined to verify active status and obtain verified customer email address.
   - **`ml_predictions`** (Analytics-ML): queried for demand forecast horizon and value.

---

## 6. Event Architecture: Outbox, Transport, & Receipts

### 6.1 Current Monolith Event Processing Pipeline

```
Domain Write (e.g. Order/Payment)
   │
   ▼
[PostgreSQL DB: Atomic Transaction]
   ├── Business Table Mutation (e.g. orders / payments)
   └── INSERT INTO outbox_events (status = 'PENDING')
   │
   ▼
[Periodic Outbox Relay (app.ts L570, every 10s)]
   ├── Claim pending outbox_events
   └── Publish to InMemoryEventTransport (Node.js EventEmitter)
   │
   ▼
[NotificationEventConsumer (extends BaseEventConsumer)]
   ├── Check schema version compatibility
   ├── Check / Claim receipt in event_consumer_receipts (UNIQUE(consumer_name, event_id))
   ├── Dispatch to handleEvent(...) -> notificationService.requestNotification(...)
   └── Update receipt status to 'COMPLETED'
```

### 6.2 Strangler Migration Implications for Events

1. **The In-Process Transport Boundary Limitation:**
   - In the monolith, `transport` is an `InMemoryEventTransport`.
   - A standalone Notifications microservice in a different process or container **cannot** listen to an in-memory `EventEmitter`.
2. **Strangler Phase Bridge Options:**
   - **Option 1 (Broker Bridge):** Configure the existing monolith outbox relay to publish to an external message broker (RabbitMQ exchange, Redis Streams, or AWS SQS) that the standalone Notifications microservice consumes.
   - **Option 2 (HTTP Forwarder Seam):** During initial strangler transition, the monolith outbox consumer can simply execute an internal HTTP POST to the new Notifications service: `POST /v1/internal/events`.
3. **Consumer Receipts Migration:**
   - `event_consumer_receipts` is currently in `commerce_db`.
   - When Notifications becomes a microservice, consumer receipts for `notification-dispatcher` must reside in the Notifications service's private database so deduplication and notification insertion can occur independently.

---

## 7. API Boundary Audit

### 7.1 Existing HTTP Endpoints

| HTTP Method | Route                                    | Auth / Actor     | Handler / Method                                  | Synchronous Dependencies                          |
| :---------- | :--------------------------------------- | :--------------- | :------------------------------------------------ | :------------------------------------------------ |
| `GET`       | `/notifications`                         | Admin            | `notificationService.listNotifications`           | Read `notifications`                              |
| `GET`       | `/notifications/:id`                     | Admin            | `notificationService.getNotificationById`         | Read `notifications`                              |
| `POST`      | `/notifications/:id/retry`               | Admin            | `notificationService.retryNotification`           | Write `notifications`                             |
| `POST`      | `/notifications/process`                 | Admin            | `notificationService.processPendingNotifications` | Claim & dispatch via Resend                       |
| `GET`       | `/customers/me/notification-preferences` | Customer / Admin | `notificationService.getCustomerPreferences`      | Read `customer_notification_preferences`          |
| `PUT`       | `/customers/me/notification-preferences` | Customer / Admin | `notificationService.setCustomerPreferences`      | Write `customer_notification_preferences`         |
| `POST`      | `/products/:id/views`                    | Customer         | `priceAlertService.recordView`                    | Check `products`, write `product_price_watches`   |
| `GET`       | `/price-alerts/mine`                     | Customer         | `priceAlertService.listMyWatches`                 | Read `product_price_watches` + `products`         |
| `DELETE`    | `/price-alerts/watches/:productId`       | Customer         | `priceAlertService.unsubscribe`                   | Write `product_price_watches`                     |
| `POST`      | `/price-alerts/sweep`                    | Admin            | `priceAlertService.sweepAll`                      | Queries 7 monolith tables + `requestNotification` |

### 7.2 Missing Inter-Service API Endpoints (Required for Microservice)

To support the monolith calling Notifications across the network, the new Notifications service will require internal service-to-service endpoints:

- `POST /v1/notifications/request`: replaces `notificationService.requestNotification(...)`.
- `POST /v1/notifications/transactional-email`: replaces `notificationService.sendTransactionalEmail(...)`.

---

## 8. Frontend Impact & Gateway Mapping

### 8.1 Frontend Touchpoints Inspected

1. **`apps/web/src/features/admin/AdminNotifications.tsx`**
   - Calls: `GET /notifications?limit=50`, `POST /notifications/:id/retry`.
   - UI: Lists platform notifications, filters by status/channel, provides manual retry button.
2. **`apps/web/src/features/auth/AccountPage.tsx`**
   - Calls: `GET /customers/me/notification-preferences`, `PUT /customers/me/notification-preferences`.
   - UI: Toggles for email, push, SMS preferences.
3. **`apps/web/src/features/catalog/api/catalog.ts`**
   - Calls: `POST /products/:id/views` inside `recordView(...)`.
   - UI: Fire-and-forget signal when a customer views a product page.
4. **`apps/web/src/features/customer/api/price-alerts.ts` & `PriceAlertsPage.tsx`**
   - Calls: `GET /price-alerts/mine`, `DELETE /price-alerts/watches/:productId`, `POST /price-alerts/sweep`.
   - UI: Displays watched products, current watching status, and allows unsubscribing.
5. **`apps/web/src/features/admin/AdminDashboard.tsx`**
   - Calls: `POST /price-alerts/sweep`.
   - UI: Admin button to trigger manual price drop evaluation.

### 8.2 API Gateway Forwarding Compatibility

- **Zero Frontend Code Breakage:** All frontend routes can remain completely unchanged if an API Gateway or reverse proxy routes path prefixes:
  - `/notifications*` → `notifications-service:4005`
  - `/customers/me/notification-preferences*` → `notifications-service:4005`
  - `/price-alerts*` → Monolith (or `price-alerts-service` once extracted)
  - `/products/:id/views` → Monolith (or `price-alerts-service` once extracted)

---

## 9. Extraction Topology Decision: Option A vs. B vs. C

### The Options

- **Option A (Extract Together as One Service):** Package Notifications and Price Alerts into a single microservice.
- **Option B (Extract Separately — Staged Approach):** Extract Notifications first as a standalone service. Keep Price Alerts in the monolith until its cross-table dependencies are refactored.
- **Option C (Remain Temporarily Together with Separate Internal Seams):** Keep both in the monolith while separating their internal code.

### Evaluation Against Verified Implementation Facts

| Architectural Dimension  | Option A (Together)                                                                                             | Option B (Extract Separately)                                                             | Option C (Keep in Monolith)                     |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- | :---------------------------------------------- |
| **Domain Purity**        | **FAIL**: Blends generic messaging transport with customer marketing/catalog analytics.                         | **PASS**: Clean separation of messaging infrastructure from business domain logic.        | **PASS**: Preserves current modular boundaries. |
| **Database Isolation**   | **FAIL**: Requires newly extracted service to query 7 foreign monolith tables or make 7 distributed HTTP calls. | **PASS**: Notifications Service owns 100% of its data with zero cross-domain SQL queries. | **PASS**: Monolith DB access remains local.     |
| **Coupling Risk**        | **HIGH**: Distributed monolith; price check failure impacts notification delivery.                              | **MINIMAL**: Independent failure isolation; message delivery is protected.                | **LOW**: Monolith deployment risk remains.      |
| **Migration Simplicity** | **COMPLEX**: Blocked by catalog, inventory, and ML query dependencies.                                          | **SIMPLE**: Notifications has zero upstream domain dependencies.                          | **TRIVIAL**: No extraction undertaken.          |

### Architectural Choice: **OPTION B (EXTRACT SEPARATELY)**

- **Decision:** **Extract NOTIFICATIONS as the First Microservice.** Leave Price Alerts inside the modular monolith for now.
- **Justification:**
  1. Notifications has zero SQL joins to foreign tables and zero foreign keys.
  2. Price Alerts is not a delivery engine; it is a pricing/catalog observation rule that triggers notifications.
  3. Extracting Price Alerts right now would force the new service to either directly access the monolith database (anti-pattern) or require immediate, premature extraction of Catalog, Listings, Inventory, Identity, and ML APIs.
  4. By extracting Notifications first, Price Alerts in the monolith simply becomes an HTTP/event client of the new Notifications service.

---

## 10. Future Service Boundary: Notifications Microservice

### 10.1 Responsibilities

- Lifecycle management of outbound communications (Email, SMS, Push).
- Customer communication preference enforcement (opt-ins, opt-outs, channel toggles).
- Delivery provider integration (Resend, Twilio, Firebase Cloud Messaging).
- Delivery retry scheduling with exponential backoff and dead-letter queue management.
- Message deduplication and database-enforced idempotency.
- Delivery audit logging and administrative governance.

### 10.2 Owned Data & Persistence

- Database: Dedicated PostgreSQL database (`notifications_db`).
- Tables:
  - `notifications`
  - `customer_notification_preferences`
  - `notification_consumer_receipts` (replicated from `event_consumer_receipts`)

### 10.3 Public & Internal API Contract

```typescript
// Public Customer / Admin Endpoints (via API Gateway)
GET    /v1/notifications                              // Admin: list logs
GET    /v1/notifications/:id                          // Admin: inspect record
POST   /v1/notifications/:id/retry                    // Admin: retry dead-lettered
POST   /v1/notifications/process                      // Admin/Worker: run batch dispatch
GET    /v1/customers/me/notification-preferences      // Customer: get preferences
PUT    /v1/customers/me/notification-preferences      // Customer: update preferences

// Internal Service-to-Service Endpoints (mTLS / Network Private)
POST   /v1/internal/notifications/request             // Monolith/Services: enqueue notification
POST   /v1/internal/notifications/transactional-email // Identity: synchronous auth email
```

### 10.4 Event Integration Contract

- **Events Consumed:**
  - `order.created.v1`
  - `payment.succeeded.v1`
  - `payment.failed.v1`
  - `fulfillment.shipment_status_changed.v1`
  - `fulfillment.return_status_changed.v1`
  - `settlement.status_changed.v1`
  - `price_alert.triggered.v1` (future refactored event)
  - `back_in_stock.triggered.v1` (future refactored event)
- **Events Published:**
  - `notification.delivered.v1` (optional observability event)
  - `notification.failed.v1` (optional observability event)

### 10.5 Idempotency & Failure Semantics

- Deterministic idempotency key: `${eventId}:${notificationType}:${recipient}:${channel}` enforced via `UNIQUE(idempotency_key)`.
- Concurrent duplicate requests receive the existing notification record without re-dispatch.
- Provider failures trigger exponential backoff: `delayMs = 1000 * 2^(attempt - 1)`, capped at 3 attempts before transitioning to `DEAD_LETTERED`.

---

## 11. Migration Sequence (Strangler Pattern)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        STRANGLER MIGRATION PHASES                      │
└────────────────────────────────────────────────────────────────────────┘
 Phase 1: Boundary Preparation in Monolith
   └── Introduce INotificationClient interface in monolith
   └── LocalNotificationService implementation preserves current behavior

 Phase 2: Standalone Service & Schema Provisioning
   └── Create apps/notifications-service (Fastify/Node.js or Go)
   └── Establish dedicated notifications_db schema & migrations
   └── Configure Resend provider & channel providers

 Phase 3: Monolith HTTP Client Adapter
   └── Implement HttpNotificationClient in apps/api
   └── Route internal monolith calls (Identity, BackInStock, PriceAlerts) via HTTP

 Phase 4: Event Bus / Broker Integration
   └── Configure outbox relay to publish to Redis Streams / RabbitMQ
   └── Notifications Service consumes events directly from broker

 Phase 5: Dual-Run / Gateway Route Cutover
   └── Route /notifications* and /customers/me/notification-preferences* via Gateway
   └── Verify customer preferences and admin dashboard against new service

 Phase 6: Decommission & Cleanup
   └── Drop notifications and customer_notification_preferences from commerce_db
   └── Remove legacy notifications module code from apps/api
```

---

## 12. Blockers, Risks, & Mitigations

| Risk / Blocker                       | Severity     | Mitigation Strategy                                                                                                                                                                                               |
| :----------------------------------- | :----------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Price Alerts Cross-Domain SQL** | **CRITICAL** | **Do not extract Price Alerts with Notifications.** Keep Price Alerts in the monolith until it is decoupled from foreign tables.                                                                                  |
| **2. In-Process Event Transport**    | **HIGH**     | The monolith uses `InMemoryEventTransport`. A network broker (Redis Streams, RabbitMQ) or outbox HTTP forwarder must be introduced before event consumption works across processes.                               |
| **3. Identity Service Sync Email**   | **MEDIUM**   | Identity registration currently awaits `sendTransactionalEmail`. The HTTP endpoint in the new service must have a tight timeout (<2s) and fail gracefully or queue asynchronously.                                |
| **4. Auth Token Verification**       | **MEDIUM**   | In monolith, `auth-middleware.ts` runs a live SQL query on `users`/`tenants`. Notifications Service should verify stateless JWT signatures or receive pre-authenticated claims (`X-Actor-*`) from an API Gateway. |
| **5. Preference Data Migration**     | **LOW**      | Customer preferences in `customer_notification_preferences` must be migrated to `notifications_db`. Because the table is small and has no foreign keys, a one-off SQL script or dual-write ensures zero downtime. |

---

## 13. Final Verdict & Concrete Prerequisites

### Verdict

# **EXTRACTION READY WITH PREREQUISITES**

_(Approved for Notifications Service extraction. Price Alerts extraction deferred to a subsequent step.)_

### Concrete Prerequisites for Notifications Service Extraction:

1. **Scope Separation Agreement:** Explicitly separate Notifications from Price Alerts. Price Alerts remains inside `apps/api` as a client of the new Notifications service.
2. **Monolith Interface Seam:** Introduce `INotificationClient` in `apps/api` with an in-memory and an HTTP implementation (`HttpNotificationClient`), allowing the monolith to delegate notification dispatch over HTTP.
3. **Inter-Process Event Delivery Seam:** Establish an inter-process bridge (e.g. Redis Streams, RabbitMQ, or an outbox HTTP webhook forwarder) so outbox events (`order.created`, etc.) can be received by external services.
4. **Dedicated Persistence Provisioning:** Provision a dedicated database configuration (`notifications_db`) and independent migrations for `notifications` and `customer_notification_preferences`.
5. **Stateless JWT Verification Seam:** Enable the new service to authenticate user requests by verifying the JWT secret without querying the monolith's `users` table.

---

## 14. Inspected Artifacts & Verification Checklist

- [x] [`apps/api/src/modules/notifications/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/index.ts)
- [x] [`apps/api/src/modules/notifications/internal/notification-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-service.ts)
- [x] [`apps/api/src/modules/notifications/internal/notification-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-repository.ts)
- [x] [`apps/api/src/modules/notifications/internal/notification-models.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-models.ts)
- [x] [`apps/api/src/modules/notifications/internal/notification-consumer.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/notification-consumer.ts)
- [x] [`apps/api/src/modules/notifications/internal/channel-providers.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/notifications/internal/channel-providers.ts)
- [x] [`apps/api/src/modules/price-alerts/index.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/index.ts)
- [x] [`apps/api/src/modules/price-alerts/internal/price-alert-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/internal/price-alert-service.ts)
- [x] [`apps/api/src/modules/price-alerts/internal/price-alert-repository.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/price-alerts/internal/price-alert-repository.ts)
- [x] [`apps/api/src/http/price-alert-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/price-alert-routes.ts)
- [x] [`apps/api/src/http/event-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/event-routes.ts)
- [x] [`apps/api/src/http/listing-routes.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/http/listing-routes.ts#L154-L156)
- [x] [`apps/api/src/modules/customer/internal/back-in-stock-service.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/customer/internal/back-in-stock-service.ts#L295-L330)
- [x] [`apps/api/src/infra/database/migrations/0009_events_and_notifications_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0009_events_and_notifications_schema.sql)
- [x] [`apps/api/src/infra/database/migrations/0018_price_watches_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0018_price_watches_schema.sql)
- [x] [`apps/api/src/app.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/app.ts#L314-L613)
- [x] [`apps/web/src/features/admin/AdminNotifications.tsx`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/admin/AdminNotifications.tsx)
- [x] [`apps/web/src/features/auth/AccountPage.tsx`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/auth/AccountPage.tsx#L83-L105)
- [x] [`apps/web/src/features/catalog/api/catalog.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/catalog/api/catalog.ts#L141-L146)
- [x] [`apps/web/src/features/customer/api/price-alerts.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/customer/api/price-alerts.ts)
- [x] [`apps/web/src/features/customer/PriceAlertsPage.tsx`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/customer/PriceAlertsPage.tsx)
- [x] [`apps/web/src/features/admin/AdminDashboard.tsx`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/web/src/features/admin/AdminDashboard.tsx#L79-L84)
