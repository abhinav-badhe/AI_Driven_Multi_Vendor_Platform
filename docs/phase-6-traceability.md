# Phase 6 Traceability Matrix: Orders & Payments

## 1. Executive Summary & Objective

Phase 6 implements the core transactional lifecycle for **Customer Orders**, **Seller Orders**, **Payment Intents**, **Payment Attempts**, **Provider Webhook Ingestion**, and **Inventory Reservation Consumption** within the AI-Driven Multi-Vendor Predictive Commerce Platform.

This phase strictly respects all architectural boundaries and invariants established in Phases 1–5:

- **Orders owns**: Customer Orders, Seller Orders, Order state machines, Order Items snapshots, and order-to-seller grouping.
- **Payment owns**: Payment Intents, Payment Attempts, Provider transaction bindings, Webhook replay protection, and Refund foundation.
- **Inventory owns**: Inventory truth, reservation lifecycle, and reservation consumption. Orders communicates with Inventory strictly through the public interface (`InventoryService.consumeReservation`).
- **Cart & Checkout owns**: Pre-order cart and checkout session orchestration up to the `READY` state.
- **Catalog & Marketplace own**: Product, SKU, and Merchant Listing truth. Orders snapshots these attributes at creation time to preserve permanent historical fidelity.

---

## 2. Requirement Traceability Matrix

| Requirement                           | Implementation Artifacts                                                                                                                                                                        | Verification / Tests                                                                                                         | Status   |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------- |
| **Customer Order Model**              | `customer_orders` table (`0006_orders_and_payments_schema.sql`), `order-repository.ts`, `order-service.ts`                                                                                      | `creates 1 Customer Order + 1 Seller Order from a single-vendor checkout`, `test/orders-and-payments.test.ts`                | **PASS** |
| **Seller Order Model (1:N)**          | `seller_orders` table, `order-repository.ts`, `order-service.ts`                                                                                                                                | `creates 1 Customer Order + N Seller Orders from a multi-vendor checkout`                                                    | **PASS** |
| **Order Snapshot Principle**          | `order_items` snapshot columns (`product_name`, `sku_code`, `variant_attributes`, `unit_price`, `currency`), `order-service.ts`                                                                 | `guarantees immutable historical snapshots of product name and variant attributes`                                           | **PASS** |
| **Order State Machine**               | `CustomerOrderStatus` (`PENDING_PAYMENT` -> `PAID` -> `PROCESSING` -> `COMPLETED`, `CANCELLED`), `SellerOrderStatus` (`PAID` -> `PROCESSING` -> `COMPLETED`, `CANCELLED`) in `order-service.ts` | `allows merchant to transition their seller order through valid states and rejects invalid transitions`                      | **PASS** |
| **Checkout -> Order Conversion**      | `OrderService.createOrderFromCheckout`, `POST /orders` in `order-routes.ts`                                                                                                                     | `creates 1 Customer Order + 1 Seller Order from a single-vendor checkout`                                                    | **PASS** |
| **Checkout Consumption Idempotency**  | Unique constraint `uq_customer_order_checkout` on `customer_orders(checkout_session_id)`                                                                                                        | `guarantees identical response and zero duplicate orders when order creation is retried`                                     | **PASS** |
| **Inventory Reservation Consumption** | `InventoryService.consumeReservation` invoked per reservation ID in `createOrderFromCheckout`                                                                                                   | `consumes inventory reservations through public Inventory interface when order is created`                                   | **PASS** |
| **Payment Provider Abstraction**      | `PaymentProvider` interface, `MockPaymentProvider` in `payment-provider.ts`                                                                                                                     | `processes successful payment attempt and transitions intent to SUCCEEDED`                                                   | **PASS** |
| **Payment Intent Lifecycle**          | `payment_intents` table, `PaymentService.createPaymentIntent`, `POST /payments/intents`                                                                                                         | `creates Payment Intent for a READY checkout session with exact minor units and currency`                                    | **PASS** |
| **Payment Attempts**                  | `payment_attempts` table, `PaymentService.createPaymentAttempt`, `POST /payments/intents/:id/attempts`                                                                                          | `records failed payment attempt with failure reason when card is declined`                                                   | **PASS** |
| **Payment Idempotency**               | Unique constraint `uq_payment_intent_idempotency (customer_tenant_id, idempotency_key)`, amount & currency check                                                                                | `enforces idempotency on payment intent creation and rejects key reuse with different amount`                                | **PASS** |
| **Webhook Signature Verification**    | HMAC-SHA256 signature verification in `MockPaymentProvider.verifyWebhookSignature`, `payment-routes.ts`                                                                                         | `verifies webhook signature and safely updates payment intent to SUCCEEDED`, `rejects webhooks with invalid signatures`      | **PASS** |
| **Webhook Deduplication**             | `payment_webhook_events` table, `uq_webhook_provider_event (provider, provider_event_id)`                                                                                                       | `deduplicates identical webhook deliveries without redundant processing (replay protection)`                                 | **PASS** |
| **Payment/Order Consistency**         | Validation requiring `paymentIntent.status === 'SUCCEEDED'` before order finalization                                                                                                           | `rejects order creation if payment intent has not succeeded`                                                                 | **PASS** |
| **Refund Foundation**                 | `payment_refunds` table, `PaymentService.createRefund`, `POST /payments/intents/:id/refund`                                                                                                     | `allows administrator to issue a refund against a succeeded payment intent`, `rejects refund attempts by non-administrators` | **PASS** |
| **Cross-Tenant Security & RBAC**      | RBAC permissions (`order:create-own`, `order:read-own`, `order:read-seller-own`, `order:read-any`, `payment:create-own`, `payment:read-own`, `payment:manage-any`)                              | `prevents Customer A from accessing Customer B order`, `prevents Merchant Alpha from reading Merchant Beta Seller Order`     | **PASS** |

---

## 3. Canonical Architecture & Core Flow

```text
Customer Cart (Phase 5)
      ↓
Checkout Session (Phase 5)
      ↓ [Status: READY]
Inventory Reservation (Phase 4/5)
      ↓
Payment Intent Created (Phase 6)
      ↓
Payment Attempt Dispatched (Phase 6)
      ↓
Verified Provider Result / Webhook Ingestion (Phase 6)
      ↓ [PaymentIntent: SUCCEEDED]
Customer Order Finalization (Phase 6)
      ├─► Seller Order Merchant Alpha [Order Items]
      └─► Seller Order Merchant Beta  [Order Items]
      ↓
Inventory Reservation Consumption (via InventoryService.consumeReservation)
```

---

## 4. Immutable Historical Snapshots

When `createOrderFromCheckout` runs, snapshot records are locked into the database:

1. **Order Level**:
   - `subtotal_amount`, `discount_amount`, `shipping_amount`, `tax_amount`, `total_amount`, `currency`, `customer_tenant_id`, `checkout_session_id`, `payment_intent_id`.
2. **Seller Order Level**:
   - `seller_tenant_id`, `subtotal_amount`, `shipping_amount`, `tax_amount`, `total_amount`, `currency`, `status`.
3. **Order Item Level**:
   - `listing_id`, `product_id`, `sku_id`, `merchant_tenant_id`, `product_name` (snapshot), `sku_code` (snapshot), `variant_attributes` (JSON snapshot), `unit_price`, `total_price`, `currency`, `quantity`.

If a merchant edits a product title, modifies SKU codes, or alters listing prices in the Catalog/Marketplace afterwards, the placed order reflects the exact commercial reality agreed upon at checkout.

---

## 5. State Machine Specifications

### Customer Order Lifecycle

```text
           ┌──────────────────────┐
           │   PENDING_PAYMENT    │
           └──────────┬───────────┘
                      │ (Payment Confirmed)
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

   Cancellation: PENDING_PAYMENT / PAID -> CANCELLED
```

### Seller Order Lifecycle

```text
           ┌──────────────────────┐
           │         PAID         │
           └──────────┬───────────┘
                      │ (Seller Acknowledged)
                      ▼
           ┌──────────────────────┐
           │      PROCESSING      │
           └──────────┬───────────┘
                      │ (Handed Over / Fulfilled in Phase 7)
                      ▼
           ┌──────────────────────┐
           │      COMPLETED       │
           └──────────────────────┘

   Cancellation: PAID -> CANCELLED
```

### Payment Intent Lifecycle

```text
           ┌──────────────────────┐
           │       CREATED        │
           └──────────┬───────────┘
                      │ (Attempt Submitted / Webhook Received)
                      ▼
           ┌──────────────────────┐
           │      PROCESSING      │
           └──────┬────────┬──────┘
                  │        │
     (Authorized) │        │ (Declined / Cancelled)
                  ▼        ▼
       ┌─────────────┐  ┌─────────────┐
       │  SUCCEEDED  │  │   FAILED    │
       └──────┬──────┘  └─────────────┘
              │ (Refund Issued)
              ▼
       ┌─────────────┐
       │  REFUNDED   │
       └─────────────┘
```

---

## 6. Crash Recovery Windows & Handling

| Scenario                                                                | System State at Crash                                                          | Recovery Mechanism                                                                                                                                                       | Invariant Guaranteed                         |
| :---------------------------------------------------------------------- | :----------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| **Case A**: Payment succeeds, process crashes before order is finalized | `PaymentIntent: SUCCEEDED`, `CustomerOrder: None`, `Reservations: ACTIVE`      | Customer retry or webhook redelivery calls `createOrderFromCheckout`. The service verifies the `SUCCEEDED` payment intent, creates the order, and consumes reservations. | Exactly 1 order created; no lost payment.    |
| **Case B**: Order finalized, network response lost                      | `PaymentIntent: SUCCEEDED`, `CustomerOrder: CREATED`, `Reservations: CONSUMED` | Customer retries `POST /orders`. The service finds existing order via `checkout_session_id`, returns assembled DTO.                                                      | Zero duplicate orders, zero duplicate items. |
| **Case C**: Webhook delivered multiple times                            | Webhook event already processed in `payment_webhook_events`                    | Duplicate detection returns `{ received: true, duplicate: true }`.                                                                                                       | Zero redundant transitions.                  |
| **Case D**: Payment attempt fails / declined                            | `PaymentIntent: FAILED`, `CustomerOrder: None`, `Reservations: ACTIVE`         | Reservations remain active until expired by background cleanup worker or checkout cancellation.                                                                          | No dangling orders; stock returned.          |
| **Case E**: Order creation retry with identical idempotency key         | Order exists in database                                                       | Service returns existing order.                                                                                                                                          | Idempotent API response.                     |

---

## 7. Deferred Phase 7+ Scope Boundaries

The following capabilities are strictly deferred and NOT implemented in Phase 6:

- **Fulfillment, Shipments & Carrier Integrations** (Deferred to Phase 7)
- **Delivery Tracking & Notifications** (Deferred to Phase 7)
- **Returns & Reverse Logistics** (Deferred to Phase 7)
- **Settlement, Merchant Payouts & Double-Entry Ledger** (Deferred to Phase 8)
- **Search & Predictive Recommendations** (Deferred to Phase 9)
- **AI WhatsApp Agents, RAG & Predictive Machine Learning** (Deferred to Phase 10+)
