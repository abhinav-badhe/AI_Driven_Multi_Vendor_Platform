# Phase 7 Traceability Matrix: Fulfillment & Returns

## 1. Executive Summary & Objective

Phase 7 implements the core transactional lifecycle for **Shipments**, **Shipment Items**, **Fulfillment Tracking**, **Delivery Status**, **Customer Returns**, **Return Items**, **Return Authorization**, and cross-boundary handoffs to **Payment Refunds** and **Inventory Restocking** within the AI-Driven Multi-Vendor Predictive Commerce Platform.

The implementation preserves the foundational system invariant:
> **Transactional systems own facts → events distribute facts → analytics explains → ML predicts → AI assists using authorized facts.**

---

## 2. Bounded-Context Ownership

* **Fulfillment owns**:
  - `shipments`: lifecycle, carrier identification, tracking numbers, tracking URLs, shipping/delivery timestamps.
  - `shipment_items`: order item assignments, fulfilled quantities per shipment.
  - `returns`: return requests, reasons, return lifecycles, authorization decisions, completion status.
  - `return_items`: return quantities, order item references, defect reasons.
  - Carrier provider integration abstraction and webhook callback verification.

* **Orders remains the authoritative owner of**:
  - `customer_orders`, `seller_orders`, `order_items`.
  - Order financial totals, payment association, order state transitions.
  - Fulfillment accesses Orders exclusively via `OrderService` public methods (`getCustomerOrder`, `getSellerOrder`, `updateSellerOrderStatus`).

* **Inventory remains the authoritative owner of**:
  - On-hand stock, reserved quantity, non-sellable stock, stock movements.
  - Fulfillment coordinates restocking exclusively via `InventoryService` public interfaces (`increaseStock`, `adjustNonSellable`).

* **Payment remains the authoritative owner of**:
  - Payment intents, payment attempts, transaction executions, refund execution.
  - Fulfillment initiates return refunds exclusively via `PaymentService.createRefund`.

* **Fulfillment MUST NOT and DOES NOT directly modify**:
  - Order tables (`customer_orders`, `seller_orders`, `order_items`).
  - Payment tables (`payment_intents`, `payment_attempts`, `payment_refunds`).
  - Inventory tables (`inventory_items`, `inventory_reservations`, `inventory_movements`).
  - Settlement/Ledger tables (deferred to Phase 8).

---

## 3. Requirement Traceability Matrix

| Requirement | Implementation Artifacts | Verification / Tests | Status |
| :--- | :--- | :--- | :--- |
| **Shipment Data Model** | `shipments`, `shipment_items` tables (`0007_fulfillment_and_returns_schema.sql`), `fulfillment-repository.ts` | `creates fulfillment shipment for a paid seller order`, `test/fulfillment-and-returns.test.ts` | **PASS** |
| **Seller Order Fulfillment Coordination** | `FulfillmentService.createShipment`, `orderService.getSellerOrder` | `creates fulfillment shipment for a paid seller order` | **PASS** |
| **Partial Fulfillment & Over-fulfillment Protection** | Calculated remaining fulfillable quantity: `orderItem.quantity - sum(fulfilled_quantities)` | `supports partial fulfillment across multiple shipments and rejects over-fulfillment` | **PASS** |
| **Shipment State Machine** | `READY_TO_SHIP` -> `SHIPPED` -> `IN_TRANSIT` -> `OUT_FOR_DELIVERY` -> `DELIVERED`, `CANCELLED`, `FAILED`, `RETURNED` | `enforces state machine: READY_TO_SHIP -> SHIPPED -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED` | **PASS** |
| **Shipment Tracking** | `carrier`, `tracking_number`, `tracking_url`, `FulfillmentService.updateShipmentTracking`, `POST /fulfillment/shipments/:id/tracking` | `updates shipment tracking information` | **PASS** |
| **Carrier Provider Callback & Webhook Verification** | `CarrierProvider` interface, `MockCarrierProvider`, HMAC-SHA256 signature verification in `POST /fulfillment/carrier/callback` | `processes signed carrier callback and transitions shipment state` | **PASS** |
| **Return Data Model** | `returns`, `return_items` tables, `fulfillment-repository.ts` | `allows customer to create return for delivered item and executes state machine through refund completion` | **PASS** |
| **Return Eligibility Verification** | Persisted fact check: order existence, customer ownership, seller order match, delivered quantity validation, and remaining eligible quantity calculation | `rejects return request for items that have NOT been delivered yet`, `enforces return quantity limits and prevents duplicate returns` | **PASS** |
| **Return State Machine** | `REQUESTED` -> `APPROVED` -> `IN_TRANSIT` -> `RECEIVED` -> `COMPLETED`, terminal `REJECTED`, `CANCELLED` | `allows customer to create return for delivered item and executes state machine through refund completion` | **PASS** |
| **Payment Refund Handoff** | `PaymentService.createRefund` triggered on return `COMPLETED` with deterministic idempotency key `ref_ret_${returnId}` | `allows customer to create return for delivered item and executes state machine through refund completion` | **PASS** |
| **Inventory Restocking Handoff** | Restocking via `InventoryService.increaseStock` (sellable) or `InventoryService.adjustNonSellable` (defective) | `restocks inventory when return is completed with restock flag`, `restocks defective inventory to non-sellable quantity` | **PASS** |
| **Idempotency & Request Fingerprinting** | Unique constraints `uq_shipment_idempotency` and `uq_return_idempotency`, parameter fingerprinting matching orders and items | `enforces idempotency on shipment creation and rejects key reuse with different payload` | **PASS** |
| **Concurrency & Race Condition Protection** | Keyed mutex locking (`withKeyLock`) per `sellerOrderId` + database transactional verification | `prevents over-fulfillment across concurrent shipment requests`, `prevents over-return across concurrent return requests` | **PASS** |
| **Cross-Boundary Failure & Recovery** | Preserving `RECEIVED` state when refund fails; deterministic retry using idempotent payment handoff | `leaves return in deterministic recoverable RECEIVED state if refund fails, and recovers idempotently on retry` | **PASS** |
| **Tenant Isolation & RBAC** | RBAC permissions: `fulfillment:create-own`, `fulfillment:read-own`, `fulfillment:update-own`, `fulfillment:manage-any`, `return:create-own`, `return:read-own`, `return:manage-own`, `return:cancel-own`, `return:manage-any` | `prevents Merchant Beta from fulfilling Merchant Alpha Seller Order`, `prevents Customer from fulfilling a shipment` | **PASS** |
| **Database Integrity & Constraints** | Check constraints `chk_shipment_status`, `chk_return_status`, `chk_shipment_items_qty_positive`, `chk_return_items_qty_positive`, foreign keys | `enforces check constraints on shipment status and positive item quantity` | **PASS** |

---

## 4. Seller Order → Shipment Hierarchy

```text
Customer Order (Phase 6)
  │
  ├──► Seller Order A (Merchant Alpha)
  │      ├──► Shipment 1 (Partial: 2 units) ──► Shipment Items
  │      └──► Shipment 2 (Partial: 3 units) ──► Shipment Items
  │
  └──► Seller Order B (Merchant Beta)
         └──► Shipment 3 (Full: 4 units)    ──► Shipment Items
```

* Each shipment item explicitly stores:
  - `shipment_id`: References the shipment row.
  - `order_item_id`: Authoritative reference to the purchased order line item.
  - `quantity`: Exact positive integer units fulfilled in this shipment.
* Invariant: `sum(shipment_items.quantity) <= order_item.quantity` across all active (non-cancelled) shipments.

---

## 5. Explicit State Machine Matrices

### 5.1 Shipment State Machine

| Current Status | Allowed Next Statuses | Actor / Mechanism |
| :--- | :--- | :--- |
| `PENDING` | `READY_TO_SHIP`, `CANCELLED` | Merchant / Administrator |
| `READY_TO_SHIP` | `SHIPPED`, `CANCELLED` | Merchant / Administrator |
| `SHIPPED` | `IN_TRANSIT`, `DELIVERED`, `FAILED` | Merchant / Carrier Webhook / Administrator |
| `IN_TRANSIT` | `OUT_FOR_DELIVERY`, `DELIVERED`, `FAILED` | Merchant / Carrier Webhook / Administrator |
| `OUT_FOR_DELIVERY` | `DELIVERED`, `FAILED` | Merchant / Carrier Webhook / Administrator |
| `DELIVERED` | `RETURNED` | Authorized Fulfillment return flow |
| `CANCELLED` | *(Terminal)* | None |
| `FAILED` | *(Terminal)* | None |
| `RETURNED` | *(Terminal)* | None |

* Disallowed Transitions:
  - `DELIVERED` -> `SHIPPED` (Deterministic 409 Conflict)
  - `DELIVERED` -> `IN_TRANSIT` (Deterministic 409 Conflict)
  - `CANCELLED` -> `SHIPPED` (Deterministic 409 Conflict)
* Automated Order Transition:
  - When all items in a Seller Order reach `DELIVERED` status across all associated shipments, the Seller Order automatically transitions to `COMPLETED`.

### 5.2 Return State Machine

| Current Status | Allowed Next Statuses | Authorized Actors |
| :--- | :--- | :--- |
| `REQUESTED` | `APPROVED`, `REJECTED`, `CANCELLED` | Merchant / Administrator (approve/reject); Customer (cancel) |
| `APPROVED` | `IN_TRANSIT`, `CANCELLED` | Merchant / Administrator (transit); Customer / Merchant (cancel) |
| `IN_TRANSIT` | `RECEIVED`, `CANCELLED` | Merchant / Administrator |
| `RECEIVED` | `COMPLETED`, `REJECTED` | Merchant / Administrator |
| `COMPLETED` | *(Terminal)* | None |
| `REJECTED` | *(Terminal)* | None |
| `CANCELLED` | *(Terminal)* | None |

* Customer Constraints:
  - Customer can only initiate `REQUESTED` returns for their own delivered order items.
  - Customer can only cancel their own returns while in `REQUESTED` or `APPROVED` state.
  - Customer CANNOT transition returns to `APPROVED`, `RECEIVED`, or `COMPLETED`.

---

## 6. Cross-Boundary Transaction & Failure Recovery

### Window A: Shipment transaction fails before commit
* **Behavior**: Transaction rolls back completely. No partial shipment or shipment items exist in the database. Fulfillable quantities remain unconsumed.

### Window B: Shipment commits, response is lost
* **Behavior**: Client retries `POST /fulfillment/shipments` with the same `idempotencyKey`. The system performs early parameter fingerprinting, detects the existing shipment, and returns the identical persisted shipment representation without duplicating fulfillment records.

### Window C: Return completion initiated, Payment refund call fails
* **Behavior**:
  1. Return is currently in `RECEIVED` status.
  2. Fulfillment invokes `paymentService.createRefund(..., idempotencyKey: "ref_ret_" + return.id)`.
  3. Payment fails (e.g. gateway timeout or payment intent issue).
  4. Exception propagates, aborting the return status update.
  5. The return remains in `RECEIVED` status (never falsely marked `COMPLETED`).
  6. Merchant or automated recovery retries the completion.

### Window D: Refund succeeds, process crashes before return completion
* **Behavior**:
  1. Payment refund record exists in Payment boundary.
  2. Return in Fulfillment is still in `RECEIVED`.
  3. When retried, Fulfillment re-calls `paymentService.createRefund` with the identical idempotency key (`ref_ret_${returnId}`).
  4. Payment's idempotent refund boundary detects the existing refund and returns it without issuing a duplicate refund.
  5. Fulfillment updates return status to `COMPLETED` and links `refundId`.

### Window E: Inventory restocking succeeds, process crashes before completion update
* **Behavior**:
  - Restocking is performed using the public `InventoryService.increaseStock` or `adjustNonSellable` interfaces with explicit deterministic reference ID (`restock_${return.id}_${item.order_item_id}`).
  - Movements enforce composite uniqueness on `(movement_type, reference_id)`.
  - On retry, `InventoryService` checks for existing movement record and returns current inventory without duplicating stock increments.
  - Return successfully transitions to `COMPLETED`.

---

## 7. Database Integrity & Constraints

Migration `0007_fulfillment_and_returns_schema.sql` establishes:
1. **Foreign Keys**:
   - `shipments.seller_order_id` references `seller_orders(id)` ON DELETE RESTRICT.
   - `shipments.customer_order_id` references `customer_orders(id)` ON DELETE RESTRICT.
   - `shipment_items.shipment_id` references `shipments(id)` ON DELETE CASCADE.
   - `shipment_items.order_item_id` references `order_items(id)` ON DELETE RESTRICT.
   - `returns.customer_order_id` references `customer_orders(id)` ON DELETE RESTRICT.
   - `returns.seller_order_id` references `seller_orders(id)` ON DELETE RESTRICT.
   - `return_items.return_id` references `returns(id)` ON DELETE CASCADE.
   - `return_items.order_item_id` references `order_items(id)` ON DELETE RESTRICT.
2. **Positive Quantity Checks**:
   - `chk_shipment_items_qty_positive`: `quantity > 0`
   - `chk_return_items_qty_positive`: `quantity > 0`
3. **State Machine Value Checks**:
   - `chk_shipment_status`: `status IN ('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED')`
   - `chk_return_status`: `status IN ('REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED')`
4. **Idempotency Constraints**:
   - `uq_shipment_idempotency`: `UNIQUE(seller_tenant_id, idempotency_key)`
   - `uq_return_idempotency`: `UNIQUE(customer_tenant_id, idempotency_key)`
   - `uq_carrier_webhook_event`: `UNIQUE(carrier, provider_event_id)` on `carrier_webhook_events`
   - `uq_inventory_movement_type_reference`: `UNIQUE(movement_type, reference_id) WHERE reference_id IS NOT NULL` on `inventory_movements`
5. **Carrier Tracking Uniqueness**:
   - `uq_shipment_carrier_tracking`: `UNIQUE(carrier, tracking_number)` (allowing nulls).
6. **Cross-Process Concurrency Locks**:
   - `SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE` applied in `createShipment` and `createReturnRequest` to serialize quantity validation across distributed instances.

---

## 8. Controlled Limitations & Strict Phase Boundaries

### Explicitly Excluded (Belongs to Phase 8+):
1. **Settlement & Ledger (Phase 8)**:
   - Double-entry bookkeeping.
   - Seller account balance adjustments.
   - Merchant payouts and platform commission deductions.
   - Financial dispute reconciliation.
2. **Search & Indexing (Phase 9)**:
   - Elasticsearch/Opensearch integration.
3. **Events & Notifications Platform (Phase 10)**:
   - Distributed event bus (Kafka/RabbitMQ).
   - Customer notification dispatcher (SMS, Email, WhatsApp).
4. **AI & Predictive Capabilities (Phase 11+)**:
   - Conversational commerce, predictive replenishment, RAG.
5. **Advanced Warehouse Management**:
   - Bin locations, picking waves, pallet tracking.
