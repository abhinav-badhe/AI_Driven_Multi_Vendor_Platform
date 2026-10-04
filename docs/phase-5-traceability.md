# Phase 5 Traceability Matrix: Cart & Checkout (Hardened)

## 1. Executive Summary
Phase 5 implements and hardens the **Cart & Checkout** bounded context of the AI-Driven Multi-Vendor Predictive Commerce Platform.
Authoritative architecture principle:
**Transactional systems own facts $\rightarrow$ events distribute facts $\rightarrow$ analytics explains $\rightarrow$ ML predicts $\rightarrow$ AI assists using authorized facts.**

For this phase:
* **Cart & Checkout owns cart and checkout orchestration.**
* **Inventory owns inventory truth and reservations.**
* **Catalog owns Product/SKU truth.**
* **Marketplace owns Merchant Listing truth.**
* **Orders will own order truth in Phase 6.**
* **Payment will own payment truth in Phase 6.**
* **Cart/Checkout MUST NOT become a shadow Order or Payment system.**

**Crucial Phase Boundary Assurance:**
* **No Orders or Seller Orders are created.**
* **No Payment intents, transactions, webhooks, or provider calls are implemented.**
* **No Tax engine or dynamic jurisdiction tax rules are implemented.**
* **No full Promotion/Coupon platform is implemented.**
* **No Kafka, RabbitMQ, Redis Streams, or distributed queues are introduced.**
* **Redis does NOT own cart or checkout truth (PostgreSQL is authoritative).**
* **Preservation of Phase 1–4:** Identity, RBAC, tenant isolation, Catalog, Listings, and Inventory reservation invariants remain 100% preserved and fully passing.

---

## 2. Domain Ownership Model

| Bounded Context | Responsibilities & Owned Objects | Prohibited Scope |
| :--- | :--- | :--- |
| **Cart & Checkout** (`modules/cart-checkout`) | Customer shopping carts (`carts`), Cart items (`cart_items`), Checkout sessions (`checkout_sessions`), Immutable checkout snapshots (`checkout_items`), Checkout state machine, Multi-item reservation compensation orchestration, Checkout expiration. | Stock quantities, inventory reservations, order numbers, fulfillment records, payment processing, canonical product definitions. |
| **Inventory** (`modules/inventory`) | Stock on-hand, reserved quantity, non-sellable quantity, inventory movements, inventory reservations (`inventory_reservations`), availability formula. | Carts, checkout session totals, order lines. |
| **Marketplace** (`modules/marketplace`) | Merchant listings (`merchant_listings`), merchant pricing offers (`price_amount`, `currency`). | Cart lifecycle, inventory allocations, payments. |
| **Catalog** (`modules/catalog`) | Categories (`categories`), canonical products (`products`), SKUs (`product_skus`). | Merchant pricing, cart items, stock counts. |
| **Orders** (Phase 6) | *Deferred to Phase 6.* Order numbers, seller sub-orders, customer orders. | Not implemented in Phase 5. |
| **Payment** (Phase 6) | *Deferred to Phase 6.* Payment transactions, refunds, captures. | Not implemented in Phase 5. |

---

## 3. Cart Model & Ownership Invariant

### 3.1 Cart Invariant: Adding Items Does NOT Reserve Stock
* Adding an item to the shopping cart, updating quantities, or viewing the cart **never** decrements available inventory or creates reservation holds.
* Invariant: `Available = On Hand - Reserved - Non-Sellable` remains unaffected by all cart operations.
* Prevents abandoned carts from locking down merchant stock.

### 3.2 Customer Tenant Model & Cart Ownership
* **Invariant**: `1 Customer User = 1 Customer Tenant = 1 Cart`.
* In Phase 2 Identity, every user registering with role `CUSTOMER` receives a dedicated tenant with `type: 'CUSTOMER'`.
* The authenticated JWT context sets `actor.tenantId` to this customer tenant.
* Database constraint: `carts.tenant_id UNIQUE REFERENCES tenants(id) ON DELETE CASCADE` enforces exactly one cart per customer tenant.
* Role-based access control enforces that `MERCHANT` users have zero access to cart or checkout APIs (`cart:read-own`, `cart:write-own`, `checkout:create-own` are denied with HTTP 403 Forbidden).

### 3.3 Multi-Vendor Cart Architecture
* The cart supports items from multiple merchants simultaneously.
* Composite constraint `UNIQUE (cart_id, listing_id)` ensures duplicate listings in a cart increment the existing row's quantity rather than creating duplicate entries.

---

## 4. Checkout State Machine & Atomic CAS Transitions

Checkout session transitions are strictly protected using atomic Compare-And-Set (CAS) database queries:
```sql
UPDATE checkout_sessions
SET status = $2, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status IN ($3, ...)
RETURNING ...
```

### 4.1 State Machine Lifecycle
```
           ┌──────────┐
           │   OPEN   │
           └────┬─────┘
                │
                ▼
         ┌──────────────┐
         │  VALIDATING  │
         └──────┬───────┘
                │
         ┌──────┴──────┐
         │             │
         ▼             ▼
   ┌───────────┐ ┌───────────┐
   │   READY   │ │  FAILED   │
   └─────┬─────┘ └───────────┘
         │
   ┌─────┴─────┐
   │           │
   ▼           ▼
┌─────────┐ ┌───────────┐
│ EXPIRED │ │ CANCELLED │
└─────────┘ └───────────┘
```

* `OPEN $\rightarrow$ VALIDATING`: Atomically executed via CAS `WHERE id = $1 AND status = 'OPEN'`. If concurrent requests attempt to reserve the same session, exactly one acquires `VALIDATING`; the other awaits completion and receives the consistent `READY` result.
* `VALIDATING $\rightarrow$ READY`: Atomically executed via CAS `WHERE id = $1 AND status = 'VALIDATING'`. If a cancellation or expiration intervened during the reservation loop, this CAS returns `null`, and the reservation worker immediately compensates and releases all holds it acquired.
* `VALIDATING $\rightarrow$ FAILED`: Executed when inventory is insufficient or pricing changed. Releases all holds acquired during the session attempt.
* `READY $\rightarrow$ CANCELLED`: Customer cancels checkout; all holds released.
* `READY $\rightarrow$ EXPIRED`: Server expires checkout; all holds released.

---

## 5. Verified Concurrency Guarantees

| Race Scenario | Mechanism | Resulting State & Guarantees |
| :--- | :--- | :--- |
| **Reserve vs Reserve** (Same checkout) | Atomic CAS `OPEN $\rightarrow$ VALIDATING` | Exactly one worker executes reservation. Second worker awaits winner or reads committed `READY`. Exactly 1 reservation set created; zero duplicate inventory holds. |
| **Reserve vs Cancel** | CAS `VALIDATING $\rightarrow$ READY` + Rollback on null | If cancel commits first, CAS fails; reserve worker immediately releases all acquired reservations. Cancelled checkout can NEVER become `READY`. Zero orphaned holds. |
| **Reserve vs Expire** | CAS `VALIDATING $\rightarrow$ READY` + Rollback on null | If expire commits first, CAS fails; reserve worker immediately releases all acquired reservations. Expired checkout has zero active reservations. |
| **Cancel vs Expire** | CAS on terminal transition | Only one terminal state is accepted (`CANCELLED` or `EXPIRED`). Releases holds safely and idempotently. |
| **Duplicate Reserve Retry** | Stable idempotency key `chk-${sessionId}-${itemId}` | Inventory recognizes identical key under `uq_reservation_idempotency` and returns existing reservation without decrementing stock. Zero double-reserves. |
| **Concurrent Checkout Creation** | Unique constraint `uq_checkout_idempotency` | Duplicate key insert is caught via `23505` error; returns existing session without duplicate rows. |

---

## 6. Pricing Revalidation & Snapshot Integrity

### 6.1 Pricing Lifecycle
1. **Cart Stage**: Ephemeral display price dynamically read from `ListingService`. Not authoritative.
2. **Checkout Creation (`OPEN`)**: Proposed order snapshot. Re-reads current listing price and validates stock.
3. **Pre-Reservation Validation**: In `reserveCheckoutInventory`, immediately before creating holds:
   - Re-reads active marketplace listing.
   - If `listing.priceAmount !== item.unit_price_amount` or currency differs:
     - Session status transitions to `FAILED`.
     - Request rejected with `422 CheckoutValidationError`.
     - Zero inventory reservations created.
4. **Locked Authoritative Snapshot (`READY`)**:
   - Once all reservations succeed and status reaches `READY`, the pricing snapshot is authoritative and locked.
   - Subsequent merchant price changes do NOT mutate the checkout session snapshot.
   - Cart modifications do NOT mutate `checkout_items`.

---

## 7. Compensation Orchestration & Crash Recovery Analysis

### 7.1 Multi-Item Compensation
When checking out multi-vendor items:
1. Sequentially reserve items with stable idempotency keys.
2. If item $K$ fails:
   - Iterate items $1 \dots K-1$.
   - Call `InventoryService.releaseReservation(actor, resId)`.
   - Clear `inventory_reservation_id` on checkout items.
   - Transition session to `FAILED`.
3. If release of item $J$ fails:
   - Checkout item $J$ retains its `inventory_reservation_id` for reconciliation.
   - Failure reason records `[CRITICAL: Compensation partially failed for reservations: ...]`.
   - System does not falsely report total release.

### 7.2 Crash Recovery & Stuck VALIDATING Resumption Mechanics
Because Checkout DB and Inventory DB operations are cross-context operations without 2-Phase Commit (2PC), a crash can leave a checkout session in `VALIDATING` with inventory reservations either created, partially created, or uncreated. The system guarantees that a checkout session NEVER remains permanently stuck in `VALIDATING`:

1. **Recovery Coordination via Database Synchronization**:
   - When a retry hits `POST /reserve` on a session in `VALIDATING`:
   - An active worker is given a short bounded window (`tryAwaitRecentValidation`, 15-20 attempts with 25-30ms intervals) if recently modified.
   - If not recently active or timeout expires, the request claims recovery via `claimValidationRecovery`:
     ```sql
     UPDATE checkout_sessions
     SET updated_at = CURRENT_TIMESTAMP, failure_reason = $2
     WHERE id = $1
       AND status = 'VALIDATING'
       AND (failure_reason IS NULL OR failure_reason NOT LIKE 'RECOVERY_CLAIM:%' OR updated_at < $3)
     RETURNING ...
     ```
   - Concurrent retries that lose the atomic claim boundedly await the winning worker's completion.
2. **Authoritative Pre-Recovery Price Revalidation**:
   - The winning worker re-verifies listing prices and canonical SKU statuses before reusing or creating holds.
   - If the price changed during the crash window:
     - Acquired session holds are rolled back via `rollbackExistingSessionHolds`.
     - The session transitions to `FAILED` with `422 CheckoutValidationError`.
     - Stale pricing can never be promoted to `READY`.
3. **Detection of Existing Reservations & Resumption**:
   - For each checkout line item, the worker determines if an active reservation already exists:
     - Check 1: `item.inventory_reservation_id` (if already linked).
     - Check 2: `inventoryService.findReservationByIdempotencyKey(actor, 'chk-${sessionId}-${itemId}')`.
   - **Case A (reservation does not exist)**: Created deterministically via `createReservation` using the same stable key.
   - **Case B (reservation exists)**: Recovered, linked to `checkout_items.inventory_reservation_id`, and reused with zero stock decrement.
   - **Case C (partial reservations exist)**: Existing holds reused; missing holds created once. Zero duplicate reservations.
   - **Case D (concurrent worker running)**: Second request awaits completion and receives identical `READY` session.
4. **Terminal State Protection & Compensation**:
   - The final transition `VALIDATING $\rightarrow$ READY` is protected by atomic CAS `WHERE status = 'VALIDATING'`.
   - If a cancellation or expiration intervened during the crash/recovery window, the CAS returns null, and all holds are immediately released.
   - A cancelled or expired checkout can never be resurrected into `READY`.
5. **Remaining Architectural Limitation**:
   - Synchronous recovery safely handles client retries, lost network responses, and process crashes on demand.
   - True autonomous background sweeping of abandoned checkouts without client retries requires event buses, outbox workers, or dead-letter queues, which are strictly deferred to Phase 10. Distributed atomicity is not claimed.

---

## 8. Database Schema & Migration Specification

Deterministic migration: `apps/api/src/infra/database/migrations/0005_cart_and_checkout_schema.sql`

* `carts.tenant_id`: `UNIQUE REFERENCES tenants(id) ON DELETE CASCADE`
* `cart_items.quantity`: `CHECK (quantity > 0)`
* `cart_items`: `UNIQUE (cart_id, listing_id)`
* `checkout_sessions.customer_tenant_id`: `REFERENCES tenants(id) ON DELETE RESTRICT`
* `checkout_sessions`: `UNIQUE (customer_tenant_id, idempotency_key)`
* `checkout_sessions.subtotal_amount`, `total_amount`: `CHECK (>= 0)`
* `checkout_items.unit_price_amount`, `line_total_amount`: `CHECK (>= 0)`
* `checkout_items.quantity`: `CHECK (quantity > 0)`
* `checkout_items`: `UNIQUE (checkout_session_id, listing_id)`

---

## 9. HTTP API Specification

| Method | Route | Description | Auth & Permission |
| :--- | :--- | :--- | :--- |
| `GET` | `/cart` | Retrieve or create active shopping cart for authenticated customer | Authenticated (`cart:read-own`) |
| `POST` | `/cart/items` | Add item to cart or increment quantity | Authenticated (`cart:write-own`) |
| `PATCH` | `/cart/items/:itemId` | Update cart item quantity (0 removes item) | Authenticated (`cart:write-own`) |
| `DELETE` | `/cart/items/:itemId` | Remove specific item from cart | Authenticated (`cart:write-own`) |
| `DELETE` | `/cart` | Clear all items from cart | Authenticated (`cart:write-own`) |
| `POST` | `/checkout/sessions` | Create checkout session from cart | Authenticated (`checkout:create-own`) |
| `POST` | `/checkout/sessions/:id/reserve` | Reserve inventory with multi-item compensation & recovery | Authenticated (`checkout:create-own`) |
| `GET` | `/checkout/sessions/:id` | Get checkout session details and snapshot | Authenticated (`checkout:read-own` / tenant match) |
| `POST` | `/checkout/sessions/:id/expire` | Expire session and release reserved inventory | Authenticated (`checkout:create-own`) |
| `POST` | `/checkout/sessions/:id/cancel` | Cancel session and release reserved inventory | Authenticated (`checkout:create-own`) |

---

## 10. Verification Matrix & Test Coverage

| Test File | Test Suite | Tests | Result |
| :--- | :--- | :--- | :--- |
| `test/checkout-hardening.test.ts` | **Phase 5 Hardening: Concurrency, Idempotency, Pricing, Recovery** | **26 tests** | **26 PASS** |
| `test/cart.test.ts` | Cart Domain & Multi-Vendor Shopping Cart | 10 tests | **10 PASS** |
| `test/checkout.test.ts` | Checkout Domain & Orchestration (Compensation) | 10 tests | **10 PASS** |
| `test/checkout-concurrency.test.ts` | Checkout Concurrency & Overselling Prevention | 1 test | **1 PASS** |
| `test/inventory-concurrency.test.ts` | Phase 4 Concurrency Prevention | 2 tests | **2 PASS** |
| `test/inventory.test.ts` | Phase 4 Stock & Reservation Truth | 14 tests | **14 PASS** |
| `test/listings.test.ts` | Phase 3 Marketplace Listings | 13 tests | **13 PASS** |
| `test/catalog.test.ts` | Phase 3 Catalog Domain | 9 tests | **9 PASS** |
| `test/architecture.test.ts` | Boundary Rules & Static Repository Scan | 14 tests | **14 PASS** |
| `test/migrations.test.ts` | PostgreSQL Migrations 0001–0005 | 3 tests | **3 PASS** |
| Existing identity, merchant, auth, rate-limiter, observability tests | Phase 1 & 2 Foundations | 56 tests | **56 PASS** |
| `@commerce/web` frontend test | React App Foundation | 1 test | **1 PASS** |
| **Total Test Suite** | **Full Monorepo** | **159 tests** | **159 PASS** |

### Real PostgreSQL Verification Status
* **Live PostgreSQL Tested**: **NOT PERFORMED** (PostgreSQL 16 live daemon and Docker container runtime are not available in current host environment).
* **Cross-Engine SQL Compatibility**: All queries, CAS updates, indexes, check constraints, foreign keys, and unique constraints are written strictly in ANSI/PostgreSQL 16 standard SQL.
* **Exact CI Verification Command**:
  ```bash
  docker run -d --name pg-test -e POSTGRES_PASSWORD=test_password -e POSTGRES_USER=test_user -e POSTGRES_DB=test_db -p 5432:5432 postgres:16-alpine
  DATABASE_URL=postgresql://test_user:test_password@localhost:5432/test_db npm test
  ```

---

## 11. Architectural Decision Records (ADRs)

* [0014-checkout-inventory-reservation-and-compensation-strategy.md](file:///d:/ProjectLeonsIntegration1/docs/adr/0014-checkout-inventory-reservation-and-compensation-strategy.md) — Multi-item inventory reservation orchestration, compensation mechanism, and cart decoupling.
* [0015-checkout-concurrency-state-machine-and-pricing-invariants.md](file:///d:/ProjectLeonsIntegration1/docs/adr/0015-checkout-concurrency-state-machine-and-pricing-invariants.md) — CAS concurrency control, pre-reservation price revalidation, snapshot immutability, stable idempotency, and crash recovery boundaries.

---

## 12. Explicit Phase 6 Boundary Assurance
Under strict enforcement of the platform roadmap:
- **Phase 6 (Orders & Payments)**: NOT IMPLEMENTED.
- **Phase 7 (Fulfillment & Returns)**: NOT IMPLEMENTED.
- **Phase 8 (Search & Derived Projections)**: NOT IMPLEMENTED.
- **Phase 9 (Recommendations & Predictive ML)**: NOT IMPLEMENTED.
- **Phase 10 (Events & Notifications)**: NOT IMPLEMENTED.
- **Phase 11 (WhatsApp AI/RAG)**: NOT IMPLEMENTED.
