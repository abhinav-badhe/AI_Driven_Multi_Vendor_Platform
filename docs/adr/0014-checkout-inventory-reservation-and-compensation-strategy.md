# ADR 0014: Checkout Multi-Item Inventory Reservation and Compensation Strategy

## Status

Accepted

## Context

In a multi-vendor e-commerce marketplace, a customer's shopping cart frequently contains multiple items across distinct merchants.
For example:

- Merchant Alpha: SKU X $\times$ 2
- Merchant Beta: SKU Y $\times$ 1
- Merchant Gamma: SKU Z $\times$ 3

When the customer proceeds to checkout, the system must coordinate inventory reservations across all of these distinct items. Under high concurrency and finite physical stock, one or more reservations may fail due to concurrent allocations or stock depletion.

A common distributed failure mode is the **partial reservation leak**:

1. Reserve SKU X $\rightarrow$ SUCCESS (2 units held on Merchant Alpha).
2. Reserve SKU Y $\rightarrow$ SUCCESS (1 unit held on Merchant Beta).
3. Reserve SKU Z $\rightarrow$ FAILURE (0 units available on Merchant Gamma).

If the checkout process simply throws an error without compensation:

- Merchant Alpha's 2 units remain locked indefinitely.
- Merchant Beta's 1 unit remains locked indefinitely.
- The customer cannot complete checkout, yet the merchants lose sellable availability for other buyers until a manual timeout occurs.

Furthermore, Cart items must **never** hold or reserve inventory before checkout; otherwise, abandoned shopping carts would lock down merchant stock.

## Decision

We establish a **Synchronous Compensating Checkout Orchestration Pattern** coupled with **Immutable Pricing Snapshots** and **Explicit Checkout Lifecycle States**.

### 1. Invariant: Cart Additions Do NOT Reserve Stock

Adding, updating, or viewing items in the shopping cart never interacts with inventory quantities:

- `on_hand_quantity`, `reserved_quantity`, and `non_sellable_quantity` remain untouched.
- Cart display pricing is dynamically derived from authoritative marketplace listings (`ListingService`) and does not represent a locked financial commitment.

### 2. Immutable Checkout Session Snapshot

When a customer initiates checkout (`POST /checkout/sessions`), the server creates an immutable session with server-calculated integer minor units:

- Revalidates that all referenced listings and canonical SKUs exist and are `ACTIVE`.
- Revalidates that all line items share uniform currency (e.g. `INR`).
- Re-reads authoritative prices directly from the marketplace domain (client cannot submit or override prices).
- Calculates deterministic totals (`subtotal = sum(quantity * unit_price)`, `discount = 0`, `shipping = 0`, `tax = 0`, `total = subtotal`).
- Creates immutable rows in `checkout_items` and sets expiration (default 15 minutes).

### 3. Multi-Item Reservation Orchestration with Automatic Compensation

When inventory reservation is triggered (`POST /checkout/sessions/:id/reserve`):

1. State Transition: `OPEN` $\rightarrow$ `VALIDATING`.
2. Sequential Allocation:
   - For each line item in `checkout_items`, call the public `InventoryService.createReservation` method with an idempotency key (`chk-${sessionId}-${itemId}`).
   - On success: Record the acquired `reservation_id` in an ephemeral array and persist it on the checkout line item.
3. **Compensation on Failure**:
   - If _any_ line item reservation fails (e.g., `InsufficientInventoryError`):
     - The orchestration immediately iterates through all already acquired reservations.
     - Calls `InventoryService.releaseReservation(actor, res.reservationId, 'Checkout reservation failure compensation')` for every acquired hold.
     - Clears the reservation reference on the checkout line item.
     - Transitions checkout session status to `FAILED` with `failure_reason`.
     - Re-throws the structured error to the client.
4. On Total Success:
   - All items acquired their holds without error.
   - Transitions checkout session status from `VALIDATING` to `READY`.
   - Records `reserved_at` timestamp.

### 4. Idempotency & Expiration

- Sessions support client idempotency via `UNIQUE (customer_tenant_id, idempotency_key)`.
- If a session is already `READY` or `RESERVED`, subsequent calls to `/reserve` return the session without re-attempting reservations.
- Expiration (`POST /checkout/sessions/:id/expire`) or cancellation (`POST /checkout/sessions/:id/cancel`):
  - Traverses all items with active `inventory_reservation_id`.
  - Releases every reservation back to sellable availability via `InventoryService.releaseReservation`.
  - Sets status to `EXPIRED` or `CANCELLED`.

## Consequences

- **Positive**:
  - Zero leaked inventory reservations upon partial failures or checkout cancellations.
  - Complete multi-vendor safety without requiring distributed cross-database 2-phase commit (2PC).
  - Clear separation of responsibilities: Inventory exclusively owns stock truth and reservations; Checkout owns orchestration, validation, and compensation.
  - No premature event/message broker infrastructure introduced prior to Phase 10.
- **Negative**:
  - Synchronous loop across items requires $O(N)$ sequential operations; however, for typical cart sizes ($N \le 20$), latency is under 50ms.
  - If a network outage occurs during compensation release, the reservation's TTL expiration serves as a second safety net.
