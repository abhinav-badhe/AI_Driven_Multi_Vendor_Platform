import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  FinancialAccountRow,
  FinancialAccountType,
  FinancialTransactionRow,
  FinancialTransactionType,
  LedgerEntryRow,
  FinancialAdjustmentRow,
  SettlementRow,
  SettlementItemRow,
  LedgerEntryType,
  LedgerDirection,
  SettlementStatus,
  FinancialAdjustmentType,
  FinancialAdjustmentStatus,
  ListLedgerEntriesFilter,
} from './types.js';

export class SettlementRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async getPlatformTenantId(): Promise<string> {
    const res = await this.db.query<{id: string}>(
      `SELECT * FROM tenants WHERE type = 'PLATFORM' ORDER BY created_at ASC LIMIT 1`
    );
    if (!res.rows[0]) throw new Error('Platform tenant not found in database');
    if (!res.rows[0].id) throw new Error(`Platform tenant returned no id: ${JSON.stringify(res.rows[0])}`);
    return res.rows[0].id;
  }

  // 1. Financial Accounts (Per Tenant, Account Type, Currency)
  async findAccountByMerchantAndCurrency(
    tenantId: string,
    currency: string,
    accountType: FinancialAccountType = 'MERCHANT_BALANCE',
  ): Promise<FinancialAccountRow | null> {
    const res = await this.db.query<FinancialAccountRow>(
      `SELECT id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
              version, created_at, updated_at
       FROM financial_accounts
       WHERE tenant_id = $1 AND account_type = $2 AND currency = $3`,
      [tenantId, accountType, currency],
    );
    return res.rows[0] ?? null;
  }

  async findAccountByMerchantAndCurrencyForUpdate(
    tenantId: string,
    currency: string,
    accountType: FinancialAccountType = 'MERCHANT_BALANCE',
  ): Promise<FinancialAccountRow | null> {
    const res = await this.db.query<FinancialAccountRow>(
      `SELECT id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
              version, created_at, updated_at
       FROM financial_accounts
       WHERE tenant_id = $1 AND account_type = $2 AND currency = $3
       FOR UPDATE`,
      [tenantId, accountType, currency],
    );
    return res.rows[0] ?? null;
  }

  async createAccount(data: {
    id: string;
    tenantId: string;
    currency: string;
    accountType?: FinancialAccountType;
  }): Promise<FinancialAccountRow> {
    const accountType = data.accountType ?? 'MERCHANT_BALANCE';
    const res = await this.db.query<FinancialAccountRow>(
      `INSERT INTO financial_accounts (
        id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance, version
      ) VALUES ($1, $2, $3, $4, 0.00, 0.00, 0.00, 1)
      ON CONFLICT (tenant_id, account_type, currency) DO UPDATE SET updated_at = NOW()
      RETURNING id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
                version, created_at, updated_at`,
      [data.id, data.tenantId, accountType, data.currency],
    );
    return res.rows[0]!;
  }

  async findAccountById(id: string): Promise<FinancialAccountRow | null> {
    const res = await this.db.query<FinancialAccountRow>(
      `SELECT id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
              version, created_at, updated_at
       FROM financial_accounts
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findAccountByIdForUpdate(id: string): Promise<FinancialAccountRow | null> {
    const res = await this.db.query<FinancialAccountRow>(
      `SELECT id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
              version, created_at, updated_at
       FROM financial_accounts
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateAccountBalances(data: {
    accountId: string;
    currentBalance: number;
    pendingBalance: number;
    settledBalance: number;
    expectedVersion: number;
  }): Promise<FinancialAccountRow | null> {
    const res = await this.db.query<FinancialAccountRow>(
      `UPDATE financial_accounts
       SET current_balance = $1,
           pending_balance = $2,
           settled_balance = $3,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $4 AND version = $5
       RETURNING id, tenant_id, account_type, currency, current_balance, pending_balance, settled_balance,
                 version, created_at, updated_at`,
      [
        data.currentBalance.toFixed(2),
        data.pendingBalance.toFixed(2),
        data.settledBalance.toFixed(2),
        data.accountId,
        data.expectedVersion,
      ],
    );
    return res.rows[0] ?? null;
  }

  // 2. Financial Transactions (Journal Boundary)
  async createFinancialTransaction(data: {
    id: string;
    tenantId: string;
    transactionType: FinancialTransactionType;
    sourceType: string;
    sourceId: string;
    currency: string;
    idempotencyKey?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<FinancialTransactionRow> {
    const res = await this.db.query<FinancialTransactionRow>(
      `INSERT INTO financial_transactions (
        id, tenant_id, transaction_type, source_type, source_id, currency, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, tenant_id, transaction_type, source_type, source_id, currency,
                idempotency_key, metadata, created_at`,
      [
        data.id,
        data.tenantId,
        data.transactionType,
        data.sourceType,
        data.sourceId,
        data.currency,
        data.idempotencyKey ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async findFinancialTransactionById(id: string): Promise<FinancialTransactionRow | null> {
    const res = await this.db.query<FinancialTransactionRow>(
      `SELECT id, tenant_id, transaction_type, source_type, source_id, currency,
              idempotency_key, metadata, created_at
       FROM financial_transactions
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findFinancialTransactionByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<FinancialTransactionRow | null> {
    const res = await this.db.query<FinancialTransactionRow>(
      `SELECT id, tenant_id, transaction_type, source_type, source_id, currency,
              idempotency_key, metadata, created_at
       FROM financial_transactions
       WHERE tenant_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findFinancialTransactionBySource(
    sourceType: string,
    sourceId: string,
    transactionType: FinancialTransactionType,
    tenantId?: string,
  ): Promise<FinancialTransactionRow | null> {
    if (tenantId) {
      const res = await this.db.query<FinancialTransactionRow>(
        `SELECT id, tenant_id, transaction_type, source_type, source_id, currency,
                idempotency_key, metadata, created_at
         FROM financial_transactions
         WHERE source_type = $1 AND source_id = $2 AND transaction_type = $3 AND tenant_id = $4
         LIMIT 1`,
        [sourceType, sourceId, transactionType, tenantId],
      );
      return res.rows[0] ?? null;
    }
    const res = await this.db.query<FinancialTransactionRow>(
      `SELECT id, tenant_id, transaction_type, source_type, source_id, currency,
              idempotency_key, metadata, created_at
       FROM financial_transactions
       WHERE source_type = $1 AND source_id = $2 AND transaction_type = $3
       LIMIT 1`,
      [sourceType, sourceId, transactionType],
    );
    return res.rows[0] ?? null;
  }

  // 3. Ledger Entries (Strict Append-Only: Insert and Read only)
  async insertLedgerEntry(data: {
    id: string;
    financialTransactionId?: string | null;
    tenantId: string;
    accountId: string;
    entryType: LedgerEntryType;
    direction: LedgerDirection;
    amount: number;
    currency: string;
    sourceType: string;
    sourceId: string;
    description: string;
    reason?: string | null;
    actorId: string;
    actorType: string;
    idempotencyKey?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<LedgerEntryRow> {
    const res = await this.db.query<LedgerEntryRow>(
      `INSERT INTO ledger_entries (
        id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
        source_type, source_id, description, reason, actor_id, actor_type,
        idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
                source_type, source_id, description, reason, actor_id, actor_type,
                idempotency_key, metadata, created_at`,
      [
        data.id,
        data.financialTransactionId ?? null,
        data.tenantId,
        data.accountId,
        data.entryType,
        data.direction,
        data.amount.toFixed(2),
        data.currency,
        data.sourceType,
        data.sourceId,
        data.description,
        data.reason ?? null,
        data.actorId,
        data.actorType,
        data.idempotencyKey ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async findLedgerEntryById(id: string): Promise<LedgerEntryRow | null> {
    const res = await this.db.query<LedgerEntryRow>(
      `SELECT id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
              source_type, source_id, description, reason, actor_id, actor_type,
              idempotency_key, metadata, created_at
       FROM ledger_entries
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findLedgerEntryByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<LedgerEntryRow | null> {
    const res = await this.db.query<LedgerEntryRow>(
      `SELECT id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
              source_type, source_id, description, reason, actor_id, actor_type,
              idempotency_key, metadata, created_at
       FROM ledger_entries
       WHERE tenant_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findLedgerEntryBySourceAndType(
    tenantId: string,
    sourceType: string,
    sourceId: string,
    entryType: LedgerEntryType,
  ): Promise<LedgerEntryRow | null> {
    const res = await this.db.query<LedgerEntryRow>(
      `SELECT id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
              source_type, source_id, description, reason, actor_id, actor_type,
              idempotency_key, metadata, created_at
       FROM ledger_entries
       WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 AND entry_type = $4
       LIMIT 1`,
      [tenantId, sourceType, sourceId, entryType],
    );
    return res.rows[0] ?? null;
  }

  async listLedgerEntries(
    tenantId: string,
    filter: ListLedgerEntriesFilter = {},
  ): Promise<LedgerEntryRow[]> {
    let query = `
      SELECT id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
             source_type, source_id, description, reason, actor_id, actor_type,
             idempotency_key, metadata, created_at
      FROM ledger_entries
      WHERE tenant_id = $1
    `;
    const params: unknown[] = [tenantId];

    if (filter.entryType) {
      params.push(filter.entryType);
      query += ` AND entry_type = $${params.length}`;
    }
    if (filter.sourceType) {
      params.push(filter.sourceType);
      query += ` AND source_type = $${params.length}`;
    }
    if (filter.sourceId) {
      params.push(filter.sourceId);
      query += ` AND source_id = $${params.length}`;
    }
    if (filter.startDate) {
      params.push(new Date(filter.startDate));
      query += ` AND created_at >= $${params.length}`;
    }
    if (filter.endDate) {
      params.push(new Date(filter.endDate));
      query += ` AND created_at <= $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';

    if (filter.limit) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }
    if (filter.offset) {
      params.push(filter.offset);
      query += ` OFFSET $${params.length}`;
    }

    const res = await this.db.query<LedgerEntryRow>(query, params);
    return res.rows;
  }

  async findUnsettledLedgerEntries(
    tenantId: string,
    currency: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<LedgerEntryRow[]> {
    const res = await this.db.query<LedgerEntryRow>(
      `SELECT le.id, le.financial_transaction_id, le.tenant_id, le.account_id, le.entry_type, le.direction, le.amount,
              le.currency, le.source_type, le.source_id, le.description, le.reason,
              le.actor_id, le.actor_type, le.idempotency_key, le.metadata, le.created_at
       FROM ledger_entries le
       LEFT JOIN settlement_items si ON le.id = si.ledger_entry_id
       WHERE le.tenant_id = $1
         AND le.currency = $2
         AND le.created_at >= $3
         AND le.created_at <= $4
         AND le.entry_type != 'PAYOUT'
         AND si.id IS NULL
       ORDER BY le.created_at ASC`,
      [tenantId, currency, periodStart, periodEnd],
    );
    return res.rows;
  }

  async getSumRefundsForSellerOrder(sellerOrderId: string, merchantId?: string): Promise<number> {
    if (merchantId) {
      const res = await this.db.query<{ total: string | number }>(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM ledger_entries
         WHERE tenant_id = $1
           AND source_type = 'REFUND'
           AND entry_type = 'REFUND'
           AND metadata->>'sellerOrderId' = $2`,
        [merchantId, sellerOrderId],
      );
      return Number(res.rows[0]?.total ?? 0);
    }
    const res = await this.db.query<{ total: string | number }>(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM ledger_entries
       WHERE source_type = 'REFUND'
         AND entry_type = 'REFUND'
         AND metadata->>'sellerOrderId' = $1`,
      [sellerOrderId],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async listLedgerEntriesByFinancialTransactionId(
    financialTransactionId: string,
  ): Promise<LedgerEntryRow[]> {
    const res = await this.db.query<LedgerEntryRow>(
      `SELECT id, financial_transaction_id, tenant_id, account_id, entry_type, direction, amount, currency,
              source_type, source_id, description, reason, actor_id, actor_type,
              idempotency_key, metadata, created_at
       FROM ledger_entries
       WHERE financial_transaction_id = $1
       ORDER BY created_at ASC`,
      [financialTransactionId],
    );
    return res.rows;
  }

  // 3. Financial Adjustments
  async createAdjustment(data: {
    id: string;
    tenantId: string;
    amount: number;
    currency: string;
    type: FinancialAdjustmentType;
    reason: string;
    status: FinancialAdjustmentStatus;
    actorId: string;
    actorType: string;
    idempotencyKey?: string | null;
  }): Promise<FinancialAdjustmentRow> {
    const res = await this.db.query<FinancialAdjustmentRow>(
      `INSERT INTO financial_adjustments (
        id, tenant_id, amount, currency, type, reason, status, actor_id, actor_type, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, tenant_id, amount, currency, type, reason, status, actor_id, actor_type,
                idempotency_key, created_at`,
      [
        data.id,
        data.tenantId,
        data.amount.toFixed(2),
        data.currency,
        data.type,
        data.reason,
        data.status,
        data.actorId,
        data.actorType,
        data.idempotencyKey ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async findAdjustmentByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<FinancialAdjustmentRow | null> {
    const res = await this.db.query<FinancialAdjustmentRow>(
      `SELECT id, tenant_id, amount, currency, type, reason, status, actor_id, actor_type,
              idempotency_key, created_at
       FROM financial_adjustments
       WHERE tenant_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  // 4. Settlements
  async createSettlement(data: {
    id: string;
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    grossAmount: number;
    commissionAmount: number;
    feeAmount: number;
    refundAmount: number;
    adjustmentAmount: number;
    netPayableAmount: number;
    status: SettlementStatus;
    idempotencyKey?: string | null;
    snapshotData: Record<string, unknown>;
  }): Promise<SettlementRow> {
    const res = await this.db.query<SettlementRow>(
      `INSERT INTO settlements (
        id, tenant_id, period_start, period_end, currency,
        gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
        net_payable_amount, status, idempotency_key, snapshot_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, tenant_id, period_start, period_end, currency,
                gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
                net_payable_amount, status, idempotency_key, snapshot_data, created_at, updated_at`,
      [
        data.id,
        data.tenantId,
        data.periodStart,
        data.periodEnd,
        data.currency,
        data.grossAmount.toFixed(2),
        data.commissionAmount.toFixed(2),
        data.feeAmount.toFixed(2),
        data.refundAmount.toFixed(2),
        data.adjustmentAmount.toFixed(2),
        data.netPayableAmount.toFixed(2),
        data.status,
        data.idempotencyKey ?? null,
        JSON.stringify(data.snapshotData),
      ],
    );
    return res.rows[0]!;
  }

  async findSettlementById(id: string): Promise<SettlementRow | null> {
    const res = await this.db.query<SettlementRow>(
      `SELECT id, tenant_id, period_start, period_end, currency,
              gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
              net_payable_amount, status, idempotency_key, snapshot_data, created_at, updated_at
       FROM settlements
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findSettlementByIdForUpdate(id: string): Promise<SettlementRow | null> {
    const res = await this.db.query<SettlementRow>(
      `SELECT id, tenant_id, period_start, period_end, currency,
              gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
              net_payable_amount, status, idempotency_key, snapshot_data, created_at, updated_at
       FROM settlements
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findSettlementByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<SettlementRow | null> {
    const res = await this.db.query<SettlementRow>(
      `SELECT id, tenant_id, period_start, period_end, currency,
              gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
              net_payable_amount, status, idempotency_key, snapshot_data, created_at, updated_at
       FROM settlements
       WHERE tenant_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async updateSettlementStatus(
    settlementId: string,
    fromStatuses: SettlementStatus[],
    toStatus: SettlementStatus,
    snapshotData?: Record<string, unknown>,
  ): Promise<SettlementRow | null> {
    const params: unknown[] = [toStatus];
    let query = `
      UPDATE settlements
      SET status = $1,
          updated_at = NOW()
    `;

    if (snapshotData) {
      params.push(JSON.stringify(snapshotData));
      query += `, snapshot_data = $2`;
    }

    const idParamIdx = params.length + 1;
    params.push(settlementId);

    const statusParamStart = params.length + 1;
    const placeholders = fromStatuses.map((_, i) => `$${statusParamStart + i}`).join(', ');
    params.push(...fromStatuses);

    query += ` WHERE id = $${idParamIdx} AND status IN (${placeholders})
      RETURNING id, tenant_id, period_start, period_end, currency,
                gross_amount, commission_amount, fee_amount, refund_amount, adjustment_amount,
                net_payable_amount, status, idempotency_key, snapshot_data, created_at, updated_at`;

    const res = await this.db.query<SettlementRow>(query, params);
    return res.rows[0] ?? null;
  }

  // 5. Settlement Items
  async linkSettlementItems(
    items: Array<{ id: string; settlementId: string; ledgerEntryId: string }>,
  ): Promise<void> {
    for (const item of items) {
      await this.db.query(
        `INSERT INTO settlement_items (id, settlement_id, ledger_entry_id)
         VALUES ($1, $2, $3)`,
        [item.id, item.settlementId, item.ledgerEntryId],
      );
    }
  }

  async findSettlementItems(settlementId: string): Promise<SettlementItemRow[]> {
    const res = await this.db.query<SettlementItemRow>(
      `SELECT id, settlement_id, ledger_entry_id, created_at
       FROM settlement_items
       WHERE settlement_id = $1
       ORDER BY created_at ASC`,
      [settlementId],
    );
    return res.rows;
  }
}
