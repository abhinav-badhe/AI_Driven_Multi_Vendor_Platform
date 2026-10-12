# ADR 0018: Marketplace Finance, Settlement & Append-Only Ledger Architecture

## Status

Accepted

## Context

Phase 8 introduces the Settlement & Ledger bounded context responsible for:

1. Multi-vendor marketplace financial attribution at the seller-order level.
2. Authoritative seller financial accounts, earnings, platform commissions, fees, refunds, and adjustments.
3. Append-only, immutable financial ledger tracking all credits and debits with strict auditability.
4. Period-based settlement calculations, financial snapshots, and state machine lifecycle (`PENDING` -> `CALCULATED` -> `APPROVED` -> `PROCESSING` -> `SETTLED`).
5. Refund compensation and administrative financial adjustments without rewriting historical facts.
6. Tenant isolation preventing merchants or customers from accessing financial data across boundaries.

Without strict architectural ownership and concurrency safeguards:

- Order or payment tables might be improperly treated as financial balance truth.
- Concurrent order completions or adjustments could lead to lost balance updates.
- Duplicate financial ingestion events could create double earnings or double refunds.
- Replaying settlement calculations could produce inconsistent payouts or alter historical records.

## Decisions

### 1. Authoritative Financial Ownership

- **Settlement/Ledger** is the sole authoritative owner of seller balances, earnings, commissions, fees, payable amounts, and ledger entries.
- Orders own order facts; Payment owns payment and provider transaction facts. Settlement consumes facts through typed application interfaces (`OrderService`, `PaymentService`) and does NOT access private tables across boundaries.

### 2. Append-Only Immutable Ledger

- All financial mutations generate immutable entries in `ledger_entries` with an explicit `direction` (`CREDIT` or `DEBIT`), `entry_type`, `amount` (NUMERIC 12,2), `currency`, `source_type`, and `source_id`.
- The repository layer exposes zero `UPDATE` or `DELETE` operations on `ledger_entries`.
- Modifications or corrections require compensating ledger entries (e.g. `REFUND`, `ADJUSTMENT`) rather than modifying historical rows.
- Settlements link ledger entries via an immutable junction table `settlement_items` (`settlement_id`, `ledger_entry_id`) with uniqueness constraints ensuring an entry is settled at most once.

### 3. Financial Invariant & Balance Double-Entry

```text
seller_net =
    seller_gross
    - commission
    - applicable_fees
    - refunds
    +/- approved_adjustments
```

At all times:

- `current_balance` on `seller_financial_accounts` strictly equals the net sum of all unsettled ledger entries.
- When a settlement reaches `SETTLED`, a `PAYOUT` debit ledger entry is posted, deducting from `current_balance` and incrementing `settled_balance`.

### 4. Database Concurrency & Row-Level Locking

- All financial operations (`ingestOrderFinancials`, `ingestRefundFinancials`, `createAdjustment`, `calculateSettlement`, `transitionSettlementStatus`) execute inside PostgreSQL database transactions (`db.withTransaction`).
- Transactions acquire a row-level lock on the seller's account:
  ```sql
  SELECT id, merchant_id, currency, current_balance, pending_balance, settled_balance, version
  FROM seller_financial_accounts
  WHERE merchant_id = $1 AND currency = $2
  FOR UPDATE
  ```
- Optimistic/versioned concurrency checks (`version = version + 1`) ensure lost updates are impossible.
- An in-memory keyed mutex serializes concurrent asynchronous requests within the same process.

### 5. Durable Database Idempotency

- Unique indexes enforce deterministic idempotency:
  - `uq_ledger_entry_idempotency` on `ledger_entries(idempotency_key)`
  - `uq_ledger_source_type_entry` on `ledger_entries(merchant_id, source_type, source_id, entry_type)`
  - `uq_financial_adj_idempotency` on `financial_adjustments(merchant_id, idempotency_key)`
  - `uq_settlement_idempotency` on `settlements(merchant_id, idempotency_key)`
- Duplicate requests return the existing historical record if identical, or reject deterministically with `ConflictError` (409) if payloads differ.

### 6. Settlement State Machine

```text
PENDING -> CALCULATED -> APPROVED -> PROCESSING -> SETTLED
                     -> REJECTED         -> FAILED -> PROCESSING
```

- Invalid state transitions (e.g. attempting to jump from `CALCULATED` to `SETTLED` or mutating terminal states) are rejected with `InvalidStateTransitionError` (409).
- Transition to `SETTLED` posts the payout debit and transfers funds from `current_balance` to `settled_balance`.

## Consequences

- Guaranteed zero duplicate earnings or refunds across retries and concurrent races.
- Guaranteed complete audit trail of every monetary movement with timestamps and actor context.
- Full multi-vendor support with isolation between competing sellers on the same customer order.
