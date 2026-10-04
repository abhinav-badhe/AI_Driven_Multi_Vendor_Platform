# ADR 0017: Fulfillment & Returns Architecture, Transaction Boundaries, and Crash Recovery

## Status
Accepted

## Context
Phase 7 introduces the Fulfillment & Returns bounded context responsible for:
1. Multi-vendor order shipment lifecycle (`PENDING` -> `READY_TO_SHIP` -> `SHIPPED` -> `IN_TRANSIT` -> `OUT_FOR_DELIVERY` -> `DELIVERED`, or `CANCELLED`/`FAILED`).
2. Order return lifecycle (`REQUESTED` -> `APPROVED` -> `IN_TRANSIT` -> `RECEIVED` -> `COMPLETED`, or `REJECTED`/`CANCELLED`).
3. Cross-boundary handoffs to Phase 6 Payment (`createRefund`) and Phase 4 Inventory (`increaseStock` / `adjustNonSellable`).
4. Carrier tracking webhooks with provider HMAC authentication and deduplicated event logging.

Without rigorous transactional boundaries, crash recovery guarantees, and concurrency controls:
- Concurrent shipment requests could over-fulfill an order item.
- Concurrent return requests could over-return delivered quantities.
- Transient network drops or process crashes during return completion could issue duplicate refunds or double-restock inventory.
- Replayed carrier callbacks could trigger inconsistent state transitions.

## Decisions

### 1. Database-Level Concurrency Serialization
To prevent over-fulfillment and over-returns across concurrent requests originating from different processes:
- In `createShipment`: Acquires a PostgreSQL transaction row lock via `SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE` prior to checking existing fulfilled quantities against ordered quantities.
- In `createReturnRequest`: Acquires `SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE` prior to checking existing returned quantities against delivered quantities.
- These database-level serializations operate in addition to process-local mutex locks, guaranteeing zero over-fulfillment and zero over-returns even in multi-instance deployments.

### 2. Return Completion Transaction Boundaries & Crash Recovery
Return completion (`updateReturnStatus(..., 'COMPLETED')`) coordinates three distinct systems:
```text
Step 1: Fulfillment DB (Read return, items, and customer order)
Step 2: PaymentService.createRefund (Phase 6 DB transaction)
Step 3: InventoryService.increaseStock / adjustNonSellable (Phase 4 DB transaction)
Step 4: Fulfillment DB (Commit return status = 'COMPLETED')
```
Because distributed two-phase commit is avoided in accordance with the modular monolith architecture:
- **Refund Idempotency Key**: Deterministically formatted as `ref_${return.idempotency_key}` or `ref_ret_${return.id}`. The Payment service validates idempotency key uniqueness globally and replays existing refunds identically on retries while rejecting key reuse with altered amounts.
- **Inventory Restock Idempotency**: `InventoryService.increaseStock` and `adjustNonSellable` accept a deterministic `referenceId` formatted as `restock_${return.id}_${item.order_item_id}`. Inventory movements enforce composite uniqueness on `(movement_type, reference_id)`. If a process crashes after restocking and completion is retried, the second invocation detects the existing movement record and returns the current stock level without adding stock twice.
- **Atomic State Handoff**: If Payment fails, the return remains in `RECEIVED` state and no inventory restock is triggered. If Inventory fails, the error bubbles up, keeping the return in `RECEIVED` state. A subsequent retry seamlessly finds the existing refund and completes the remaining inventory restock.

### 3. Carrier Webhook Authentication & Replay Protection
- Carrier webhooks verify HMAC signatures against configured carrier secrets before parsing payloads.
- Carrier webhook events are persisted to `carrier_webhook_events` with a unique constraint on `(carrier, provider_event_id)`.
- Duplicate or replayed webhook deliveries are immediately identified, recorded as deduplicated, and short-circuited without re-executing state machine transitions.

### 4. Tenant Isolation & RBAC
- Customers can only read and create returns for their own orders, and can only transition returns to `CANCELLED`.
- Merchants can only view and manage shipments and returns belonging to their own seller orders.
- Cross-tenant shipment and return access attempts are deterministically rejected with `403 Forbidden`.

## Consequences
- Guaranteed zero duplicate refunds across crash windows and retries.
- Guaranteed zero duplicate inventory restocking across retries.
- Guaranteed zero shipment over-fulfillment and return over-request under high concurrency.
- Full auditability of inventory movements and carrier webhook deliveries.
