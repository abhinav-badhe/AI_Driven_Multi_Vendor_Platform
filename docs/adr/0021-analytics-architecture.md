# ADR 0021: Analytics Bounded Context & Event-Driven Analytical Read Model Architecture

## Status
Accepted

## Context
Phase 11 introduces the platform's durable, event-driven analytics foundation. It consumes business facts published through the Phase 10 event infrastructure, records immutable analytical facts and dimensions, computes aggregated metrics and commerce KPIs, and exposes dashboard-ready analytical query APIs without becoming a source of transactional truth.

### Key Architectural Invariants & Boundary Rules
1. **Analytics is Derived and Read-Only with Respect to Transactional Truth**:
   The authoritative transactional truth remains strictly owned by upstream business domains:
   - Orders owns order truth
   - Inventory owns inventory truth and current physical stock
   - Payment owns payment truth
   - Settlement/Ledger owns financial truth
   - Catalog owns product truth
   - Marketplace owns seller listing truth
   - Identity/Customer owns customer account truth
   Analytics consumes domain events emitted by these authoritative contexts. It MUST NOT write to transactional tables (`orders`, `seller_orders`, `order_items`, `inventory`, `inventory_reservations`, `payment_intents`, `payment_attempts`, `payment_refunds`, `settlements`, `ledger_entries`, `products`, `merchant_listings`).

2. **Event-Driven Ingestion via Phase 10 Infrastructure**:
   Analytics ingests domain events using the Phase 10 event infrastructure (`EventTransport`, `BaseEventConsumer`, and `OutboxRepository`). It does NOT create a second independent event bus, bypass the standardized `DomainEvent` envelope, or directly query transactional databases.

3. **At-Least-Once Delivery & Durable Deduplication**:
   Under Phase 10 at-least-once transport delivery semantics, duplicate events can arrive. Deduplication is durable in the database (`event_consumer_receipts` table with `UNIQUE(consumer_name, event_id)` and fact table `ON CONFLICT DO NOTHING` clauses). In-memory Sets or process-local maps are strictly prohibited as primary correctness mechanisms.

4. **Immutable Analytical Facts**:
   Historical facts capture state at the time of event occurrence:
   - Order price at purchase $\neq$ Current catalog price
   - Historical seller attribution $\neq$ Current listing state
   Facts are stored with their historical `occurred_at` timestamps and values. They are never overwritten when current catalog or merchant records mutate later.

---

## Decisions

### 1. Analytics Bounded Context Ownership
The `analytics` module owns:
- **Analytical Facts**: `analytics_order_facts`, `analytics_payment_facts`, `analytics_fulfillment_facts`, `analytics_settlement_facts`, `analytics_catalog_facts`
- **Analytical Aggregates**: `analytics_daily_metrics` (aggregated by tenant, merchant, metric date, granularity, and currency)
- **Data Quality & Quarantine**: `analytics_quarantine_records`
- **Administrative Rebuild Audit**: `analytics_rebuild_audit`

### 2. Events Consumed
`AnalyticsEventConsumer` subscribes to the canonical Phase 10 events:
- **Orders**: `order.created.v1`, `order.status_changed.v1`
- **Payments**: `payment.succeeded.v1`, `payment.failed.v1`, `payment.refund_created.v1`
- **Fulfillment**: `fulfillment.shipment_created.v1`, `fulfillment.shipment_status_changed.v1`, `fulfillment.return_status_changed.v1`
- **Settlement**: `settlement.status_changed.v1`
- **Catalog**: `catalog.product.created.v1`, `catalog.product.updated.v1`, `catalog.product.archived.v1`
- **Marketplace**: `marketplace.listing.created.v1`, `marketplace.listing.updated.v1`, `marketplace.listing.deactivated.v1`

*Note:* Inventory change and reservation events are currently `DEFERRED / NOT CURRENTLY AVAILABLE` in the Phase 10 event catalog. In accordance with platform governance, no synthetic production events were invented.

### 3. Monetary Representation & Currency Isolation
- All monetary amounts in analytical facts and aggregates are represented with `NUMERIC(14,4)` precision.
- Floating-point arithmetic is strictly avoided.
- Currency is explicitly partitioned (`currency VARCHAR(3)`). The system never aggregates across different currencies without conversion.

### 4. Deterministic Aggregation & Late Event Handling
- Daily aggregates in `analytics_daily_metrics` are maintained per `(tenant_id, merchant_id, metric_date, granularity, currency)`.
- When an event arrives out-of-order or late (e.g. an order with `occurred_at` from 2 days prior), the immutable fact is recorded with its original timestamp, and `AnalyticsRepository.recomputeDailyMetric` re-aggregates the specific historical date.
- This guarantees that late events update historical reporting accurately without double-counting.

### 5. KPI Definitions
- **Total Orders**: `COUNT(DISTINCT order_id)` from order facts.
- **Gross Sales**: `COALESCE(SUM(total_amount), 0.0000)` from created order line facts.
- **Refund Amount**: `COALESCE(SUM(amount), 0.0000)` for payment facts where `status = 'REFUNDED'`.
- **Net Sales**: `MAX(0, Gross Sales - Refund Amount)`.
- **Average Order Value (AOV)**: `Gross Sales / Total Orders` (evaluates to `0.0000` when `Total Orders = 0`).
- **Units Sold**: `COALESCE(SUM(quantity), 0)` from created order line facts.
- **Payment Success / Failure Rates**: `succeeded_payments / total_payments` and `failed_payments / total_payments`.

### 6. Administrative Rebuild & Reconciliation
- The `POST /analytics/rebuild` endpoint allows platform administrators to reconstruct all analytical facts and daily metrics for a tenant from the authoritative `outbox_events` store.
- **Atomic Failure Semantics**: Rebuild executes within a database transaction. If any event fails during replay, the transaction rolls back completely (preventing corrupted partial states), an audit record is logged in `analytics_rebuild_audit` with `status = 'FAILED'`, and an HTTP 500 error is thrown. A successful HTTP response never represents a partial rebuild.
- **Concurrency Safety**: `clearTenantAnalytics` runs first within the transaction, followed by querying `outbox_events` and replaying facts via `ON CONFLICT (fact_id) DO NOTHING`. Any live events arriving concurrently are neither deleted nor double-counted.

### 7. Customer Privacy & Sensitive Data Safeguards
- Analytics stores only anonymized identifiers (`customerId`, `merchantId`, `productId`).
- Passwords, access tokens, refresh tokens, credit card PANs, CVVs, and raw email bodies are blocked by Phase 10 envelope scanning (`FORBIDDEN_PAYLOAD_KEYS`) and omitted from analytical schema tables.

### 7. RBAC & Multi-Tenant Authorization
- **ADMINISTRATOR**: May query platform-wide aggregates, query any tenant (`?tenantId=...`), filter by merchant, and trigger administrative rebuilds (`analytics:read-any`, `analytics:rebuild`).
- **MERCHANT**: Scoped strictly to their own tenant and merchant ID (`analytics:read-own`). Forbidden from querying other merchants or platform totals.
- **CUSTOMER**: Access to analytics APIs is rejected (`403 Forbidden`).

### 8. Phase 12 & 13 Boundary
Phase 11 strictly avoids predictive machine learning, recommendation engines, forecasting, or WhatsApp/RAG intelligence. It establishes clean, governed historical analytical data models that Phase 12 (Recommendations) and Phase 13 (Predictive ML) can consume without directly mutating transactional domains.

### 9. Future Storage Abstraction
The `AnalyticsRepository` encapsulates all analytics persistence behind a repository interface, ensuring future migrations to a dedicated analytical warehouse (e.g. Snowflake, ClickHouse, BigQuery, DuckDB) will not alter domain consumers or API response contracts.
