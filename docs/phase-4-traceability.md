# Phase 4 Traceability Matrix: Inventory & Concurrency-Safe Stock Management

## 1. Executive Summary
Phase 4 implements the **Inventory** bounded context of the AI-Driven Multi-Vendor Predictive Commerce Platform.
Authoritative architecture principle:
**Transactional systems own facts $\rightarrow$ events distribute facts $\rightarrow$ analytics explains $\rightarrow$ ML predicts $\rightarrow$ AI assists using authorized facts.**

For this phase:
**Inventory exclusively owns stock truth.**
**PostgreSQL is the transactional source of truth.**

**Crucial Phase Boundary Assurance:**
* **Inventory is NOT owned by Catalog, Marketplace, Cart, Checkout, or Orders.**
* **No Cart, Checkout, Orders, Payments, Fulfillment, Returns, Settlement, Search, Notifications, Recommendations, Predictive ML, WhatsApp AI/RAG, or later phase functionality is implemented.**
* **Redis is NOT used as inventory truth.**
* **AI/ML is NOT permitted to mutate inventory.**
* **Preservation of Phase 1, 2, and 3:** All existing authentication, RBAC, tenant context, error handling, logging, categories, products, SKUs, and merchant listings remain fully preserved and operational.

---

## 2. Domain Ownership Model

| Bounded Context | Responsibilities & Owned Objects | Prohibited Scope |
| :--- | :--- | :--- |
| **Inventory** (`modules/inventory`) | Inventory records (`inventory_items`), On-hand quantity, Reserved quantity, Non-sellable quantity, Authoritative availability calculations, Inventory reservations (`inventory_reservations`), Reservation lifecycle, Stock adjustments, Concurrency control, Append-only movement history (`inventory_movements`). | Product attributes, listing prices, carts, checkout sessions, order records, payment statuses. |
| **Catalog** (`modules/catalog`) | Canonical products (`products`), categories (`categories`), variants/SKUs (`product_skus`). | Stock quantities, inventory movements, reservations, merchant pricing. |
| **Marketplace** (`modules/marketplace`) | Merchant listings (`merchant_listings`), pricing offers (`price_amount`, `currency`). | Stock quantities, warehouses, reservations, stock adjustments. |
| **Identity & Merchant** (`modules/identity`, `modules/merchant`) | Users, sessions, tenant context, RBAC, merchant onboarding and verification. | Stock counts, stock reservations, product definitions. |

---

## 3. Core Inventory Model & Multi-Vendor Stock Boundary

### 3.1 Authoritative Availability Invariant
The single, authoritative formula for sellable inventory availability across the entire system is:
$$\mathbf{Available = On\ Hand - Reserved - Non\text{-}Sellable}$$

* This invariant is strictly enforced at the database level:
  `CONSTRAINT chk_availability_non_negative CHECK (on_hand_quantity - reserved_quantity - non_sellable_quantity >= 0)`
* Also enforced in atomic conditional SQL statements before any mutation can proceed.
* No conflicting secondary availability calculations exist anywhere in the codebase.

### 3.2 Multi-Vendor Marketplace Stock Separation
* Inventory is attached to a specific **Merchant Listing boundary** (`listing_id UNIQUE REFERENCES merchant_listings(id)`), which resolves to an authenticated `tenant_id` and canonical `sku_id`.
* **Zero Global Stock**: Inventory is **never** maintained as a global count for a canonical Product or SKU.
* **Independent Stock**: Two distinct merchants (Merchant A and Merchant B) selling the exact same canonical SKU have completely independent inventory records with independent quantities, reservations, and movement histories.
* Inventory creation requires an existing `merchant_listings` record owned by the authenticated merchant tenant.

---

## 4. Database Schema & Migration Specification

Deterministic migration: `apps/api/src/infra/database/migrations/0004_inventory_schema.sql`

### 4.1 Tables, Constraints, and Indexes

#### 1. `inventory_items`
* `id` VARCHAR(36) PRIMARY KEY
* `tenant_id` VARCHAR(36) NOT NULL REFERENCES `tenants(id)` ON DELETE CASCADE
* `listing_id` VARCHAR(36) NOT NULL UNIQUE REFERENCES `merchant_listings(id)` ON DELETE CASCADE
* `sku_id` VARCHAR(36) NOT NULL REFERENCES `product_skus(id)` ON DELETE CASCADE
* `on_hand_quantity` INTEGER NOT NULL DEFAULT 0
* `reserved_quantity` INTEGER NOT NULL DEFAULT 0
* `non_sellable_quantity` INTEGER NOT NULL DEFAULT 0
* `version` INTEGER NOT NULL DEFAULT 1
* `created_at` TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
* `updated_at` TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP

**Database Invariants / Constraints:**
* `chk_on_hand_non_negative`: `CHECK (on_hand_quantity >= 0)`
* `chk_reserved_non_negative`: `CHECK (reserved_quantity >= 0)`
* `chk_non_sellable_non_negative`: `CHECK (non_sellable_quantity >= 0)`
* `chk_reserved_le_on_hand`: `CHECK (reserved_quantity <= on_hand_quantity)`
* `chk_availability_non_negative`: `CHECK (on_hand_quantity - reserved_quantity - non_sellable_quantity >= 0)`

**Indexes:**
* `idx_inventory_tenant` on `(tenant_id)`
* `idx_inventory_listing` on `(listing_id)`
* `idx_inventory_sku` on `(sku_id)`

#### 2. `inventory_reservations`
* `id` VARCHAR(36) PRIMARY KEY
* `inventory_id` VARCHAR(36) NOT NULL REFERENCES `inventory_items(id)` ON DELETE CASCADE
* `tenant_id` VARCHAR(36) NOT NULL REFERENCES `tenants(id)` ON DELETE CASCADE (merchant owner of stock)
* `customer_tenant_id` VARCHAR(36) REFERENCES `tenants(id)` ON DELETE SET NULL (reserving customer tenant)
* `quantity` INTEGER NOT NULL
* `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
* `idempotency_key` VARCHAR(128)
* `expires_at` TIMESTAMPTZ
* `consumed_at` TIMESTAMPTZ
* `released_at` TIMESTAMPTZ
* `created_at` TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
* `updated_at` TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP

**Database Constraints:**
* `chk_reservation_quantity_positive`: `CHECK (quantity > 0)`
* `chk_reservation_status`: `CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED'))`
* `uq_reservation_idempotency`: `UNIQUE (tenant_id, idempotency_key)`

**Indexes:**
* `idx_reservations_inventory` on `(inventory_id)`
* `idx_reservations_tenant` on `(tenant_id)`
* `idx_reservations_status` on `(status)`
* `idx_reservations_expires` on `(expires_at)`

#### 3. `inventory_movements` (Append-Only Auditable Ledger)
* `id` VARCHAR(36) PRIMARY KEY
* `inventory_id` VARCHAR(36) NOT NULL REFERENCES `inventory_items(id)` ON DELETE CASCADE
* `tenant_id` VARCHAR(36) NOT NULL REFERENCES `tenants(id)` ON DELETE CASCADE
* `movement_type` VARCHAR(64) NOT NULL
* `quantity_delta` INTEGER NOT NULL
* `previous_on_hand` INTEGER NOT NULL
* `new_on_hand` INTEGER NOT NULL
* `previous_reserved` INTEGER NOT NULL
* `new_reserved` INTEGER NOT NULL
* `previous_non_sellable` INTEGER NOT NULL
* `new_non_sellable` INTEGER NOT NULL
* `reference_id` VARCHAR(128)
* `actor_id` VARCHAR(64) NOT NULL
* `notes` TEXT
* `created_at` TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP

**Database Constraints:**
* `chk_movement_type`: `CHECK (movement_type IN ('INITIAL_STOCK', 'STOCK_INCREASE', 'STOCK_DECREASE', 'RESERVATION_HOLD', 'RESERVATION_RELEASE', 'RESERVATION_CONSUME', 'NON_SELLABLE_ADJUSTMENT', 'MANUAL_ADJUSTMENT'))`

**Indexes:**
* `idx_movements_inventory` on `(inventory_id)`
* `idx_movements_tenant` on `(tenant_id)`
* `idx_movements_created` on `(created_at)`

---

## 5. Reservation Lifecycle & State Machine

Reservations are strictly managed via a closed state machine:

```
                  ┌──────────────────────┐
                  │        ACTIVE        │
                  └──────────┬───────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌──────────────────┐┌──────────────────┐┌──────────────────┐
│     RELEASED     ││     CONSUMED     ││     EXPIRED      │
│    (Terminal)    ││    (Terminal)    ││    (Terminal)    │
└──────────────────┘└──────────────────┘└──────────────────┘
```

### Transition Invariants:
1. `ACTIVE` $\rightarrow$ `RELEASED`: Decrements `reserved_quantity` by reserved amount. Restores availability.
2. `ACTIVE` $\rightarrow$ `CONSUMED`: Decrements `reserved_quantity` and decrements `on_hand_quantity` by reserved amount. Permanent consumption upon order confirmation/checkout.
3. `ACTIVE` $\rightarrow$ `EXPIRED`: Decrements `reserved_quantity` by reserved amount. Restores availability.
4. **Forbidden Transitions**:
   - `RELEASED` $\rightarrow$ `ACTIVE` (REJECTED)
   - `CONSUMED` $\rightarrow$ `ACTIVE` (REJECTED)
   - `EXPIRED` $\rightarrow$ `ACTIVE` (REJECTED)
   - Double release / double consume / double expire are rejected with `InvalidStateTransitionError` (HTTP 409).

---

## 6. Concurrency Strategy & Overselling Prevention

### The Race Condition Problem
In standard e-commerce implementations, two concurrent requests each requesting 7 units against 10 on-hand stock can read available = 10, pass validation, and reserve 14 units, resulting in -4 available units.

### The Solution: Atomic Conditional SQL with Row-Level Invariant
Every reservation allocation executes:
```sql
UPDATE inventory_items
SET reserved_quantity = reserved_quantity + CAST($1 AS INTEGER),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $2
  AND (on_hand_quantity - reserved_quantity - non_sellable_quantity) >= CAST($1 AS INTEGER)
RETURNING ...
```

1. PostgreSQL locks the targeted row.
2. The condition `(on_hand - reserved - non_sellable) >= requested` is evaluated against the current committed state.
3. If Request A commits first reserving 7 of 10, the row's reserved quantity becomes 7 and available becomes 3.
4. When Request B evaluates the condition against the locked row, `(10 - 7 - 0) >= 7` evaluates to `FALSE`. Zero rows are updated.
5. The application detects the failure, rolls back the transaction, and throws `InsufficientInventoryError` (HTTP 409 Conflict).
6. **Overselling is mathematically impossible.**

---

## 7. Transactional Consistency & Movement History

Every inventory modification takes place within an atomic database transaction (`db.withTransaction`):

1. **Reservation Hold**:
   - `UPDATE inventory_items` (atomic conditional hold)
   - `INSERT inventory_reservations` (status `ACTIVE`)
   - `INSERT inventory_movements` (type `RESERVATION_HOLD`)
2. **Reservation Release**:
   - `UPDATE inventory_reservations` (status `ACTIVE` $\rightarrow$ `RELEASED`)
   - `UPDATE inventory_items` (decrement `reserved_quantity`)
   - `INSERT inventory_movements` (type `RESERVATION_RELEASE`)
3. **Reservation Consumption**:
   - `UPDATE inventory_reservations` (status `ACTIVE` $\rightarrow$ `CONSUMED`)
   - `UPDATE inventory_items` (decrement both `reserved_quantity` and `on_hand_quantity`)
   - `INSERT inventory_movements` (type `RESERVATION_CONSUME`)
4. **Stock Adjustment (Increase/Decrease/Non-Sellable)**:
   - `UPDATE inventory_items` (atomic conditional adjustment)
   - `INSERT inventory_movements` (type `STOCK_INCREASE`, `STOCK_DECREASE`, or `NON_SELLABLE_ADJUSTMENT`)

If any query fails or a constraint is violated, the entire transaction rolls back cleanly. No orphaned reservations or untracked stock shifts can occur.

---

## 8. Idempotency Strategy

- Reservations support an optional `idempotencyKey` provided in the request payload or header.
- A composite unique constraint `uq_reservation_idempotency UNIQUE (tenant_id, idempotency_key)` protects against duplicate reservations caused by network timeouts, client retries, or duplicate submissions.
- When an identical idempotency key is submitted for the same tenant, the existing reservation is returned idempotently without double-allocating stock.

---

## 9. Security, RBAC & Multi-Tenant Isolation

1. **Verified Security Context**:
   - Tenant identity (`actor.tenantId`) is derived exclusively from the verified Phase 2 JWT security context.
   - Client-supplied tenant IDs in headers, queries, or bodies are ignored.
2. **Cross-Tenant Access Prevention**:
   - Merchant A cannot view, adjust, reserve, release, or consume Merchant B's inventory.
   - Cross-tenant requests are rejected with `ForbiddenError` (HTTP 403).
3. **Role & Permission Mapping**:
   - `inventory:create`: `MERCHANT` (for own listings)
   - `inventory:read-own`: `MERCHANT` (view own stock details, reserved counts, movements)
   - `inventory:read-any`: `ADMINISTRATOR`
   - `inventory:adjust-own`: `MERCHANT` (increase stock, decrease stock, adjust non-sellable)
   - `inventory:reserve`: `CUSTOMER`, `MERCHANT`, `ADMINISTRATOR` (hold stock)
   - `inventory:release-own`: `CUSTOMER` (release own reservation), `MERCHANT` (release reservations on own stock)
   - `inventory:consume-own`: `MERCHANT` (consume reservation on own stock), `ADMINISTRATOR`
   - `inventory:manage-any`: `ADMINISTRATOR`
4. **Public vs. Internal Exposure**:
   - Public endpoint `GET /inventory/public/listings/:listingId/availability` sanitizes responses, exposing only:
     `{ listingId, skuId, isAvailable, availableQuantity }`
   - Internal quantities (`onHandQuantity`, `reservedQuantity`, `nonSellableQuantity`, `version`, `movements`) are restricted to authorized merchant owners and platform administrators.

---

## 10. HTTP API Specification

| Method | Route | Description | Auth & Permission |
| :--- | :--- | :--- | :--- |
| `POST` | `/inventory` | Initialize inventory for a merchant listing with baseline stock | Authenticated (`inventory:create`) |
| `GET` | `/inventory/:id` | Get internal inventory details by ID | Authenticated (`inventory:read-own` / tenant match) |
| `GET` | `/inventory/listings/:listingId` | Get internal inventory details by listing ID | Authenticated (`inventory:read-own` / tenant match) |
| `GET` | `/inventory` | List all inventory items owned by authenticated merchant | Authenticated (`inventory:read-own`) |
| `POST` | `/inventory/:id/increase-stock` | Increase on-hand stock | Authenticated (`inventory:adjust-own` / tenant match) |
| `POST` | `/inventory/:id/decrease-stock` | Decrease on-hand stock | Authenticated (`inventory:adjust-own` / tenant match) |
| `POST` | `/inventory/:id/non-sellable` | Adjust non-sellable quantity | Authenticated (`inventory:adjust-own` / tenant match) |
| `GET` | `/inventory/:id/movements` | View audit movement history for an item | Authenticated (`inventory:read-own` / tenant match) |
| `POST` | `/inventory/reservations` | Create reservation hold | Authenticated (`inventory:reserve`) |
| `GET` | `/inventory/reservations/:id` | Get reservation details | Authenticated (reserving customer or stock owner) |
| `POST` | `/inventory/reservations/:id/release` | Release active reservation | Authenticated (`inventory:release-own`) |
| `POST` | `/inventory/reservations/:id/consume` | Consume active reservation | Authenticated (`inventory:consume-own`) |
| `GET` | `/inventory/public/listings/:listingId/availability` | Public sanitized availability query | Public (No auth required) |

---

## 11. Verification Matrix & Test Coverage

| Test Area | Test File | Cases Covered | Result |
| :--- | :--- | :--- | :--- |
| **Inventory Creation & Validation** | `test/inventory.test.ts` | Valid creation, duplicate listing rejection, nonexistent listing rejection, cross-tenant listing rejection. | **PASS** |
| **Availability Calculation** | `test/inventory.test.ts` | $On\ Hand - Reserved - Non\text{-}Sellable$, zero available boundary, exact available boundary, negative availability prevention. | **PASS** |
| **Sanitized Public View** | `test/inventory.test.ts` | Verifies raw internal quantities (`reservedQuantity`, `nonSellableQuantity`, `movements`) are stripped. | **PASS** |
| **Controlled Stock Adjustments** | `test/inventory.test.ts` | Increases stock, decreases stock, rejects decreases exceeding available stock, non-sellable adjustments, movement auditing. | **PASS** |
| **Reservation Lifecycle** | `test/inventory.test.ts` | Hold $\rightarrow$ Release, Hold $\rightarrow$ Consume, Hold $\rightarrow$ Expire, double release rejection, double consume rejection. | **PASS** |
| **Multi-Vendor Stock Separation** | `test/inventory.test.ts` | Merchant A and B stock independent for same SKU; cross-tenant read, modify, release, and consume prevention. | **PASS** |
| **Concurrency & Overselling** | `test/inventory-concurrency.test.ts` | 2 concurrent requests for 7 units against 10 stock (exactly 1 succeeds, 0 oversell); 10 parallel requests storm (5 succeed, 5 reject, 0 oversell). | **PASS** |
| **Architecture Boundaries** | `test/architecture.test.ts` | Strict isolation of `inventory/internal/`; domain-to-HTTP decoupled; static scan of all repository files proves 0 violations. | **PASS** |
| **Database Migrations** | `test/migrations.test.ts` | Applies 0001 through 0004; verifies all tables, CHECK constraints, foreign keys, and indexes. | **PASS** |

### Real PostgreSQL Verification Status
- All migrations and database constraints are designed and written PostgreSQL-natively.
- Unit and integration tests execute against the test adapter with explicit casting (`CAST($1 AS INTEGER)`).
- **PostgreSQL CI/Container Verification Path**: Run `DATABASE_URL=postgres://user:pass@localhost:5432/commerce npm test` in CI environments running a live PostgreSQL 16 container.

---

## 12. Architectural Decision Records (ADRs)

* [0013-inventory-concurrency-and-reservation-strategy.md](file:///d:/ProjectLeonsIntegration1/docs/adr/0013-inventory-concurrency-and-reservation-strategy.md) — Explains the atomic conditional update strategy, reservation lifecycle state machine, and mathematical prevention of overselling.

---

## 13. Explicit Phase 4 Boundary Assurance
Under strict enforcement of the platform roadmap:
- **Phase 5 (Cart & Checkout)**: NOT IMPLEMENTED.
- **Phase 6 (Orders & Payments)**: NOT IMPLEMENTED.
- **Phase 7 (Fulfillment & Returns)**: NOT IMPLEMENTED.
- **Phase 8 (Search & Derived Projections)**: NOT IMPLEMENTED.
- **Phase 9 (Recommendations & Predictive ML)**: NOT IMPLEMENTED.
- **Phase 10 (Events & Notifications)**: NOT IMPLEMENTED.
- **Phase 11 (WhatsApp AI/RAG)**: NOT IMPLEMENTED.
