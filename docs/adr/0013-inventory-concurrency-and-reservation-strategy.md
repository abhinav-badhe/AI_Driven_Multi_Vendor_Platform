# ADR 0013: Inventory Concurrency Control and Reservation Strategy

## Status
Accepted

## Context
In a multi-vendor e-commerce platform, inventory overselling is a catastrophic failure mode. When high-demand items or limited flash sales occur, multiple checkout and cart sessions attempt to allocate the same remaining physical stock concurrently. 

A common anti-pattern in distributed or layered architectures is:
1. `SELECT available_quantity FROM inventory WHERE ...` (application memory reads available = 5)
2. Application checks `if (requested <= available)`
3. Application issues `UPDATE inventory SET reserved = reserved + requested WHERE ...`

Under concurrent load (e.g., two concurrent requests requesting 4 units when 5 are available), both threads read 5, both pass application validation, and both issue updates, resulting in 8 units reserved against 5 on-hand stock (an oversell of 3 units).

Furthermore, the authoritative availability formula is:
$$\text{Available} = \text{On Hand} - \text{Reserved} - \text{Non-Sellable}$$

We must ensure:
1. Complete concurrency safety without race conditions or overselling.
2. Atomic transactions encompassing inventory adjustments, reservation records, and append-only movement history.
3. Multi-vendor stock separation so Merchant A's inventory is strictly isolated from Merchant B's inventory, even when selling the exact same canonical SKU.
4. Deterministic, database-enforced invariants (PostgreSQL as transactional source of truth).

## Decision

We adopt an **Atomic Conditional Row-Update with Pessimistic Invariant Guarding** strategy directly at the PostgreSQL layer, combined with comprehensive database `CHECK` constraints.

### 1. Atomic Conditional Updates (Preventing Race Conditions)
Instead of an uncoordinated read-then-write cycle, reservations and stock reductions execute atomic conditional updates where the condition and the mutation are evaluated within the database engine in a single atomic step:

```sql
UPDATE inventory_items
SET reserved_quantity = reserved_quantity + CAST($1 AS INTEGER),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $2
  AND (on_hand_quantity - reserved_quantity - non_sellable_quantity) >= CAST($1 AS INTEGER)
RETURNING id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version, created_at, updated_at;
```

#### Why this prevents overselling:
- In PostgreSQL, an `UPDATE` acquiring a row lock evaluates the `WHERE` clause against the latest committed tuple version.
- When Request A and Request B concurrently target the same inventory row with 10 on-hand units and 0 reserved units, each requesting 7 units:
  1. The first transaction to acquire the row lock on `inventory_items` tests the predicate `(10 - 0 - 0) >= 7` (TRUE), increments `reserved_quantity` to 7, and commits.
  2. The second transaction waits for the row lock. Upon acquiring the lock, it re-evaluates the predicate against the updated row: `(10 - 7 - 0) >= 7` $\rightarrow$ `3 >= 7` (FALSE).
  3. The `UPDATE` matches 0 rows and returns null.
  4. The application layer detects zero rows updated, throws `InsufficientInventoryError` (HTTP 409 Conflict), and safely rolls back the transaction.
- Overselling is mathematically impossible because the predicate is evaluated atomically with the lock.

### 2. Multi-Layer Database Invariants
In addition to the conditional `WHERE` clause, PostgreSQL enforces hard table constraints:
```sql
CONSTRAINT chk_on_hand_non_negative CHECK (on_hand_quantity >= 0),
CONSTRAINT chk_reserved_non_negative CHECK (reserved_quantity >= 0),
CONSTRAINT chk_non_sellable_non_negative CHECK (non_sellable_quantity >= 0),
CONSTRAINT chk_reserved_le_on_hand CHECK (reserved_quantity <= on_hand_quantity),
CONSTRAINT chk_availability_non_negative CHECK (on_hand_quantity - reserved_quantity - non_sellable_quantity >= 0)
```
Even if an application defect attempted an invalid decrement, PostgreSQL rejects the transaction with a check constraint violation before any data is committed.

### 3. Reservation Lifecycle State Machine
Reservations follow a strict, domain-enforced state machine:
- `ACTIVE` $\rightarrow$ `RELEASED` (terminal)
- `ACTIVE` $\rightarrow$ `CONSUMED` (terminal)
- `ACTIVE` $\rightarrow$ `EXPIRED` (terminal)

Transitions out of terminal states (`RELEASED`, `CONSUMED`, `EXPIRED`) are permanently forbidden. Double-release and double-consumption are prevented by conditional status updates:
```sql
UPDATE inventory_reservations
SET status = $3, ...
WHERE id = $1 AND status = $2
```

### 4. Append-Only Auditable Movement History
Every stock mutation occurs inside an atomic transaction that inserts an immutable row into `inventory_movements` capturing:
- `movement_type` (`INITIAL_STOCK`, `STOCK_INCREASE`, `STOCK_DECREASE`, `RESERVATION_HOLD`, `RESERVATION_RELEASE`, `RESERVATION_CONSUME`, `NON_SELLABLE_ADJUSTMENT`)
- `quantity_delta`
- Snapshot of previous and new `on_hand`, `reserved`, and `non_sellable` quantities
- `reference_id` (e.g. reservation ID) and authenticated `actor_id`.

No quantity update can ever occur without a corresponding audit movement record.

### 5. Multi-Vendor Stock Ownership Boundary
Inventory records have a `1:1` relationship with `merchant_listings` (`listing_id UNIQUE REFERENCES merchant_listings(id)`).
- Canonical SKUs never possess global stock.
- Merchant A's inventory for SKU X is completely separate from Merchant B's inventory for SKU X.
- Tenant isolation is strictly enforced via verified actor authentication (`actor.tenantId`).

## Consequences

- **Positive**:
  - Zero overselling under high concurrency.
  - No external distributed locking service (e.g. ZooKeeper, Redis Redlock) required, eliminating distributed deadlock risks.
  - Complete transactional atomicity (all-or-nothing mutations).
  - Full auditability via append-only movement history.
  - High read throughput for public availability queries.
- **Negative**:
  - Contention on highly competitive single items may result in lock waits up to the database query timeout.
  - Clients experiencing concurrent stock depletion receive HTTP 409 Conflict and must handle backoff or communicate out-of-stock conditions to end users.
