# ADR 0016: Orders and Payments Architecture, State Machines, and Crash Recovery

## Status

Accepted (Phase 6)

## Context

Phase 6 of the AI-Driven Multi-Vendor Predictive Commerce Platform requires transitioning completed, validated checkouts into canonical customer and seller orders, backed by an auditable, provider-independent payment subsystem.

The architecture must satisfy the following critical constraints:

1. **Multi-Vendor Canonical Decomposition**: A customer places a single order across multiple merchants. The platform must represent this as 1 `Customer Order` containing N `Seller Orders` (where N is the number of distinct merchant tenants represented in the checkout), with line items allocated strictly to their respective seller orders.
2. **Immutable Historical Snapshots**: Orders must preserve financial and catalog truth permanently (product title, variant attributes, SKU code, unit price, discounts, taxes, and shipping charges) independent of future catalog or listing modifications.
3. **Provider-Independent Payment Abstraction**: The payment subsystem must decouple platform business logic from specific payment gateways (e.g., Stripe, Adyen, Razorpay) via a domain interface (`PaymentProvider`), separating domain `Payment Intent` from transient/auditable `Payment Attempt` records.
4. **Authoritative Consistency & No Fake Atomicity**: No distributed two-phase commit (2PC) or distributed lock manager exists across Orders, Payments, and Inventory. Invariants must be upheld via explicit database transactions, authoritative snapshot checks, idempotent transitions, and crash-resilient compensation/reconciliation workflows.
5. **Inventory Ownership Boundary**: Orders and Payments must never touch inventory database tables directly. Inventory reservations created during Checkout must be transitioned to `CONSUMED` strictly through the public interface (`InventoryService.consumeReservation`).

## Decision

### 1. Domain Ownership and Order Decomposition

- **Orders Module**:
  - Owns `customer_orders`, `seller_orders`, and `order_items`.
  - Owns the order lifecycle state machines and immutable line item snapshots.
  - Decomposes a multi-vendor checkout into exactly 1 `Customer Order` and N `Seller Orders` partitioned by `merchant_tenant_id`.
  - Guarantees uniqueness with `uq_customer_order_checkout (checkout_session_id)` to prevent multiple orders from being minted from a single checkout session.
- **Payment Module**:
  - Owns `payment_intents`, `payment_attempts`, `payment_webhook_events`, and `payment_refunds`.
  - Owns payment lifecycle transitions and provider reference bindings.
  - Enforces idempotency via `uq_payment_intent_idempotency (customer_tenant_id, idempotency_key)` and `uq_payment_attempt_idempotency (payment_intent_id, idempotency_key)`.
- **Inventory Module Contract**:
  - Maintains sole ownership of stock truth and reservation consumption.
  - `OrderService` consumes reservations using the checkout session's stored reservation IDs via `inventoryService.consumeReservation(systemActor, reservationId)`.

### 2. State Machines

#### Customer Order Lifecycle

```text
           ┌──────────────────────┐
           │   PENDING_PAYMENT    │
           └──────────┬───────────┘
                      │ (Payment Succeeded)
                      ▼
           ┌──────────────────────┐
           │         PAID         │
           └──────────┬───────────┘
                      │ (Merchant Starts Processing)
                      ▼
           ┌──────────────────────┐
           │      PROCESSING      │
           └──────────┬───────────┘
                      │ (All Seller Orders Completed)
                      ▼
           ┌──────────────────────┐
           │      COMPLETED       │
           └──────────────────────┘

   Cancellation Path:
   PENDING_PAYMENT / PAID ──> CANCELLED
```

#### Seller Order Lifecycle

```text
           ┌──────────────────────┐
           │         PAID         │
           └──────────┬───────────┘
                      │ (Merchant Acknowledges & Packs)
                      ▼
           ┌──────────────────────┐
           │      PROCESSING      │
           └──────────┬───────────┘
                      │ (Handed over / Ready for Fulfillment in Phase 7)
                      ▼
           ┌──────────────────────┐
           │      COMPLETED       │
           └──────────────────────┘

   Cancellation Path:
   PAID ──> CANCELLED
```

#### Payment Intent Lifecycle

```text
           ┌──────────────────────┐
           │       CREATED        │
           └──────────┬───────────┘
                      │ (Attempt Dispatched / Webhook Received)
                      ▼
           ┌──────────────────────┐
           │      PROCESSING      │
           └──────┬────────┬──────┘
                  │        │
     (Authorized) │        │ (Declined / Expired)
                  ▼        ▼
       ┌─────────────┐  ┌─────────────┐
       │  SUCCEEDED  │  │   FAILED    │
       └──────┬──────┘  └─────────────┘
              │ (Full Refund)
              ▼
       ┌─────────────┐
       │  REFUNDED   │
       └─────────────┘
```

#### Payment Attempt Lifecycle

`PENDING` -> `PROCESSING` -> `SUCCEEDED` / `FAILED`

### 3. Payment Idempotency and Webhook Replay Protection

1. **Payment Intent Creation**: Requests include `idempotencyKey`. If an existing intent matches the key and customer tenant, the existing intent is returned. If the requested amount or currency differs from the recorded record, request is rejected with `400 Validation Error`.
2. **Payment Attempts**: Repeated attempts with identical keys return the existing attempt and provider reference without creating duplicate charges.
3. **Webhook Ingestion**:
   - The webhook endpoint requires cryptographic signature verification (`x-webhook-signature` or `stripe-signature`) verified via HMAC-SHA256 against a shared secret.
   - Replay attacks are prevented via the `payment_webhook_events` table with unique constraint `uq_webhook_provider_event (provider, provider_event_id)`.
   - Webhook retries are logged as duplicates and acknowledged with HTTP 200 without duplicate state transitions.

### 4. Crash Recovery and Transactional Integrity

- **Case A: Payment succeeds, but process crashes before order finalized**:
  - The payment intent state is already persisted as `SUCCEEDED`.
  - Subsequent client retry or webhook delivery invokes order creation. The order service inspects the authoritative `SUCCEEDED` payment intent and completes order finalization and inventory reservation consumption idempotently.
- **Case B: Order finalized, network response lost**:
  - Client retries `POST /orders` with the same `checkoutSessionId`.
  - `findCustomerOrderByCheckoutSession` detects the existing order and returns the assembled order DTO with HTTP 201/200 without creating duplicate records.
- **Case C: Payment webhook delivered multiple times**:
  - `payment_webhook_events` unique constraint catches repeated deliveries. The handler returns `{ received: true, duplicate: true }` with zero side effects.
- **Case D: Payment fails**:
  - Payment intent moves to `FAILED`. Checkout remains in `READY` (or transitions according to policy). Active inventory reservations remain subject to expiration by the background reservation cleanup worker without stock leakage.
- **Case E: Inventory consumption retry**:
  - If reservation was already consumed during a partial order transaction, subsequent attempts verify status or handle idempotent consumption safely.

## Consequences

### Positive

- Perfect 1-to-N customer-to-seller order decomposition preserves multi-vendor commercial independence.
- Zero leakage across tenant boundaries: customers only see their orders; merchants only see their seller orders.
- Historical audit integrity guaranteed: product renames and listing price updates never affect previously placed orders.
- Strict decoupling: Payment provider logic is isolated behind `PaymentProvider` interface.

### Negative / Trade-offs

- State synchronization across asynchronous webhooks requires at-least-once recovery logic.
- Ledger and payout calculations are intentionally deferred to Phase 8, requiring snapshot totals to be carefully preserved in minor units for future reconciliation.
