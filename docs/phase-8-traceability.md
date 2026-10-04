# Phase 8 Traceability Matrix: Marketplace Finance / Settlement & Ledger

## 1. Executive Summary & Objective

Phase 8 implements the authoritative financial core for **Seller Financial Accounts**, **Seller Earnings**, **Platform Commissions**, **Platform Fees**, **Customer Refund Compensations**, **Financial Adjustments**, **Settlement Calculations**, **Settlement State Machine**, and an **Append-Only Immutable Ledger** within the AI-Driven Multi-Vendor Predictive Commerce Platform.

The implementation preserves the foundational system invariant:
> **Transactional systems own facts → events distribute facts → analytics explains → ML predicts → AI assists using authorized facts.**

---

## 2. Bounded-Context Ownership

* **Settlement/Ledger owns**:
  - `seller_financial_accounts`: Authoritative accounting balances (`current_balance`, `pending_balance`, `settled_balance`, `version`).
  - `ledger_entries`: Append-only, immutable historical ledger entries (`EARNING`, `COMMISSION`, `FEE`, `REFUND`, `ADJUSTMENT`, `PAYOUT`) with directional signs (`CREDIT`, `DEBIT`), monetary amounts (NUMERIC 12,2), timestamps, and actor context.
  - `financial_adjustments`: Administrator-governed credit/debit adjustments for subsidies, disputes, and penalties.
  - `settlements`: Settlement batch records, calculation snapshots, period ranges, net payable amounts, and state machine transitions.
  - `settlement_items`: Immutable junction linking settlement batches to ledger entries, enforcing that each entry is settled at most once.

* **Orders owns**:
  - `customer_orders`, `seller_orders`, `order_items`.
  - Settlement/Ledger consumes order facts strictly via typed public methods on `OrderService` (`getSellerOrder`).

* **Payment owns**:
  - `payment_intents`, `payment_attempts`, `payment_refunds`.
  - Settlement/Ledger consumes refund facts strictly via typed public methods on `PaymentService` (`getPaymentIntent`, `getRefund`).

* **Inventory owns**:
  - Stock levels and reservations.

* **Settlement/Ledger DOES NOT**:
  - Directly query or mutate private tables of Orders, Payment, Cart, Checkout, or Inventory.
  - Duplicate order state machine logic.
  - Rely on floating-point arithmetic (strictly NUMERIC 12,2).

---

## 3. Requirement Traceability Matrix

| Requirement | Implementation Artifacts | Verification / Tests | Status |
| :--- | :--- | :--- | :--- |
| **Authoritative Seller Financial Accounts** | `seller_financial_accounts` (`0008_settlement_and_ledger_schema.sql`), `SettlementRepository` | `accurately attributes gross, commission, and net earnings per seller independently`, `test/settlement-and-ledger.test.ts` | **PASS** |
| **Append-Only Immutable Ledger** | `ledger_entries` table, repository has zero update/delete methods | `enforces append-only immutable ledger and verifies financial invariant`, `proves SettlementRepository has zero update or delete methods on ledger_entries` | **PASS** |
| **Financial Invariants** | `seller_net = gross - commission - fees - refunds +/- adjustments`, double-entry balance consistency | `enforces append-only immutable ledger and verifies financial invariant` | **PASS** |
| **Multi-Vendor Attribution** | Independent per-seller order ingestion, separate seller balances on shared customer orders | `accurately attributes gross, commission, and net earnings per seller independently` | **PASS** |
| **Platform Commission & Fee Model** | Configurable platform commission (default 10%) & fee debits per seller order | `accurately attributes gross, commission, and net earnings per seller independently` | **PASS** |
| **Compensating Refund Entries** | `ingestRefundFinancials` creates `REFUND` debit and optional commission reversal credit | `compensates refund with seller debit and commission reimbursement, preventing double-debit on retry` | **PASS** |
| **Administrative Adjustments** | `financial_adjustments` + `ADJUSTMENT` ledger entry (CREDIT/DEBIT) | `Case G: concurrent seller balance mutations do not lose balance updates`, `validates adjustment input bounds` | **PASS** |
| **Settlement Calculation & Snapshots** | Period-based query over unsettled entries, immutable snapshot in `snapshot_data`, links via `settlement_items` | `executes full settlement lifecycle: CALCULATED -> APPROVED -> PROCESSING -> SETTLED with payout debit` | **PASS** |
| **Settlement State Machine** | `PENDING` -> `CALCULATED` -> `APPROVED` -> `PROCESSING` -> `SETTLED`, rejection/failure branches | `executes full settlement lifecycle: CALCULATED -> APPROVED -> PROCESSING -> SETTLED with payout debit`, `Case I: terminal settlement states reject further transitions` | **PASS** |
| **Payout Execution** | `PAYOUT` debit entry posted on `SETTLED`, transferring `current_balance` to `settled_balance` | `executes full settlement lifecycle: CALCULATED -> APPROVED -> PROCESSING -> SETTLED with payout debit` | **PASS** |
| **Durable Database Idempotency** | Unique indexes `uq_ledger_entry_idempotency`, `uq_ledger_source_type_entry`, `uq_financial_adj_idempotency`, `uq_settlement_idempotency` | `Case A/B/C: handles concurrent duplicate order ingestion safely without duplicating balance or ledger entries`, `Case H: rejects idempotency key reuse with different amount or payload` | **PASS** |
| **Concurrency & Row Locking** | `SELECT ... FOR UPDATE` on `seller_financial_accounts` inside transactions + in-memory keyed mutex | `Case G: concurrent seller balance mutations do not lose balance updates` | **PASS** |
| **Transaction Rollback & Crash Recovery** | Atomic `withTransaction` boundaries rolling back partial records on failure | `Case D & E: transaction rollback during settlement calculation leaves zero partial settlement records or items` | **PASS** |
| **Tenant Isolation & RBAC** | RBAC permissions: `settlement:read-own`, `settlement:manage-any`, cross-tenant rejection | `prevents Merchant Beta from reading Merchant Alpha financial summary or ledger`, `prevents Customer from reading seller financial balances or settlements` | **PASS** |
| **Architecture Boundary Enforcement** | Zero cross-module private imports between Settlement and Orders/Payment | `test/architecture.test.ts` (16 boundary tests) | **PASS** |
