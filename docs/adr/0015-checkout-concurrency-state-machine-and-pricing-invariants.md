# ADR 0015: Checkout Concurrency, Atomic State Transitions, and Authoritative Pricing Invariants

## Status
Accepted

## Context
Phase 5 established the Cart & Checkout bounded context. During Phase 5 hardening, rigorous audit of transactional boundaries, distributed crash windows, and race conditions revealed six concurrency and data-integrity requirements necessary before building Phase 6 Orders & Payments:
1. **Concurrent Reserve Calls**: Simultaneous `POST /reserve` requests must never allocate duplicate inventory reservations.
2. **Reserve vs Cancel/Expire Race Conditions**: A concurrent cancellation or expiration must never be overwritten by a late reservation completing, leaving a session in `READY` when cancelled or leaving orphaned inventory reservations.
3. **Price Revalidation**: Cart display prices and checkout `OPEN` snapshot prices must be authoritatively verified against the marketplace listing immediately prior to reserving inventory stock.
4. **Idempotency Fingerprint**: Idempotency keys must be protected against misuse where identical keys are reused with materially changed cart contents.
5. **Partial-Failure & Crash Recovery**: Cross-context operations between Checkout and Inventory cannot rely on distributed transactions (2PC). Boundaries and crash states must be deterministic and auditable.
6. **Cart Ownership Invariant**: The relationship between authenticated customers and shopping carts must be rigorously verified against the Phase 2 Identity model.

## Decision

### 1. Atomic Compare-And-Set (CAS) State Transitions
All checkout session transitions are executed using conditional database updates:
```sql
UPDATE checkout_sessions
SET status = $2, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status IN ($3, ...)
RETURNING ...
```
- **`OPEN` $\rightarrow$ `VALIDATING`**: Only a single concurrent caller can transition from `OPEN` to `VALIDATING`. Losers of this CAS detect that another worker is actively reserving and either return an already-committed `READY` state or wait briefly for completion.
- **`VALIDATING` $\rightarrow$ `READY`**: Executed after all line item reservations succeed. If a concurrent `cancel` or `expire` occurred during the reservation loop, the DB status is no longer `VALIDATING`. The CAS returns `null`, and the reservation worker immediately compensates and rolls back all holds it just acquired.
- **`VALIDATING` $\rightarrow$ `FAILED`**: Executed on reservation failure, recording explicit failure reasons and any uncompensated hold references.
- **Terminal States**: `READY $\rightarrow$ CANCELLED`, `READY $\rightarrow$ EXPIRED`, `OPEN $\rightarrow$ CANCELLED`, `OPEN $\rightarrow$ EXPIRED`. Once `CANCELLED` or `EXPIRED`, the state is immutable.

### 2. Stable Idempotency Keys for Line Item Holds
Every inventory reservation request uses a deterministic key derived from stable entities:
$$\text{idempotencyKey} = \text{chk-}\{\text{sessionId}\}\text{-}\{\text{itemId}\}$$
Retries (e.g. following network drop) reuse the identical key. The Inventory domain's `uq_reservation_idempotency UNIQUE (tenant_id, idempotency_key)` constraint ensures zero duplicate reservations.

### 3. Authoritative Pricing Lifecycle
1. **Cart**: Ephemeral display price dynamically read from `ListingService`. Not authoritative.
2. **Checkout Creation (`OPEN`)**: Proposed order snapshot. Server re-reads listing prices and validates inventory availability.
3. **Pre-Reservation Validation**: In `reserveCheckoutInventory`, before creating reservation holds, the system re-reads the active marketplace listing. If the unit price or currency has changed, the checkout transitions to `FAILED` with `CheckoutValidationError`, rejecting stale pricing.
4. **Locked Authoritative Snapshot (`READY`)**: Once reservations succeed and status reaches `READY`, the pricing snapshot is authoritative and locked. Subsequent merchant price changes do not mutate this snapshot. Cart updates do not mutate `checkout_items`.

### 4. Idempotency Key Fingerprint Validation
When a customer supplies an `idempotencyKey` on `POST /checkout/sessions`:
- If an existing session matches `(customer_tenant_id, idempotency_key)`, its items are compared against the current cart.
- If items or quantities differ, the system throws `CheckoutValidationError('Idempotency key reuse detected with different cart contents')`.
- Concurrent inserts with identical keys are caught via PostgreSQL constraint `uq_checkout_idempotency` and reconciled safely.

### 5. Crash Recovery Boundaries & Stuck VALIDATING Recovery
Because Checkout DB and Inventory DB operations are not in a single distributed 2PC transaction:
- **Crash Recovery Mechanism**: When a process crashes during reservation execution while the checkout session is in `VALIDATING` state:
  1. A subsequent `/reserve` retry detects `VALIDATING`.
  2. The retry uses database-level synchronization (`claimValidationRecovery`) with an atomic conditional `UPDATE checkout_sessions ... WHERE status = 'VALIDATING' AND (failure_reason IS NULL OR failure_reason NOT LIKE 'RECOVERY_CLAIM:%' OR updated_at < $cutoff)` to claim recovery rights.
  3. Concurrent retries that lose the claim race boundedly await the winning worker via `tryAwaitRecentValidation` rather than executing redundant work.
  4. The recovering worker checks each checkout item against Inventory:
     - First via `item.inventory_reservation_id` (if already recorded).
     - Second via `inventoryService.findReservationByIdempotencyKey(actor, 'chk-${sessionId}-${itemId}')`.
  5. **Detection & Resumption**:
     - **Case A (reservation does not exist)**: Missing reservation is created using the same deterministic idempotency key.
     - **Case B (reservation exists)**: Existing active reservation is recovered, linked to `checkout_items.inventory_reservation_id`, and reused without creating a second hold.
     - **Case C (partial reservations exist)**: Existing reservations are reused; missing reservations are created once.
     - **Case D (reservation workflow actively running)**: Concurrent requests boundedly await completion without duplicating work.
  6. **Authoritative Price Revalidation**: Recovery does not bypass price validation. Before acquiring or promoting holds, the marketplace listing price and SKU status are re-verified. If the price changed during the crash window, acquired holds are rolled back and the session transitions to `FAILED`.
  7. **Terminal State Protection**: The transition from `VALIDATING` to `READY` is guarded by CAS `WHERE status = 'VALIDATING'`. If `cancel` or `expire` was committed during the crash or recovery window, the CAS fails and any acquired holds are immediately released. A cancelled or expired checkout cannot be resurrected into `READY`.
  8. **Partial Compensation Tracking**: If hold release fails during rollback, the line item retains `inventory_reservation_id`, and `failure_reason` is appended with `[CRITICAL: Compensation partially failed for reservations: ...]`.
- **Remaining Limitation**: This mechanism provides synchronous bounded recovery for client retries. True asynchronous background self-healing reconciliation (e.g., dead letter queues, outbox background workers, scheduled sweeping daemons) is strictly deferred to future event and infrastructure phases (Phase 10). Distributed atomicity is not claimed.

### 6. Cart Ownership Invariant
In Phase 2 Identity, every user with role `CUSTOMER` is assigned a dedicated customer tenant (`type: 'CUSTOMER'`). The invariant `1 Customer = 1 Customer Tenant = 1 Cart` is enforced by `carts.tenant_id UNIQUE REFERENCES tenants(id)`. Merchants have role `MERCHANT` and have zero access to cart or checkout APIs.

## Consequences
- Zero race conditions between checkout reservation, cancellation, and expiration.
- Checkouts never remain permanently stuck in `VALIDATING` after a process crash; subsequent retries deterministically recover or safely fail.
- Zero duplicate or leaked inventory reservations across crashes and concurrent retries.
- Guaranteed price integrity preventing stale or hijacked pricing during recovery.
- Complete architectural compliance with Phase 1–5 domain boundaries without premature infrastructure overhead.

