export type LedgerEntryType =
  | 'EARNING'
  | 'COMMISSION'
  | 'FEE'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'PAYOUT'
  | 'CLEARING'
  | 'COMMISSION_REVENUE'
  | 'FEE_REVENUE'
  | 'REFUND_REVERSAL';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export type SettlementStatus =
  | 'PENDING'
  | 'CALCULATED'
  | 'APPROVED'
  | 'PROCESSING'
  | 'SETTLED'
  | 'FAILED'
  | 'REJECTED';

export type FinancialAdjustmentType = 'CREDIT' | 'DEBIT';
export type FinancialAdjustmentStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED';

export type FinancialAccountType =
  | 'MERCHANT_BALANCE'
  | 'CLEARING'
  | 'COMMISSION_REVENUE'
  | 'FEE_REVENUE'
  | 'PAYOUT_CASH';

export type FinancialTransactionType =
  | 'ORDER_EARNING'
  | 'COMMISSION'
  | 'FEE'
  | 'REFUND'
  | 'COMMISSION_REVERSAL'
  | 'ADJUSTMENT'
  | 'PAYOUT';

export interface FinancialAccountRow {
  id: string;
  tenant_id: string;
  account_type: FinancialAccountType;
  currency: string;
  current_balance: string | number;
  pending_balance: string | number;
  settled_balance: string | number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface FinancialAccountDto {
  id: string;
  tenantId: string;
  accountType: FinancialAccountType;
  currency: string;
  currentBalance: number;
  pendingBalance: number;
  settledBalance: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialTransactionRow {
  id: string;
  tenant_id: string;
  transaction_type: FinancialTransactionType;
  source_type: string;
  source_id: string;
  currency: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface FinancialTransactionDto {
  id: string;
  tenantId: string;
  transactionType: FinancialTransactionType;
  sourceType: string;
  sourceId: string;
  currency: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  entries?: LedgerEntryDto[] | undefined;
}

export interface LedgerEntryRow {
  id: string;
  financial_transaction_id: string | null;
  tenant_id: string;
  account_id: string;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount: string | number;
  currency: string;
  source_type: string;
  source_id: string;
  description: string;
  reason: string | null;
  actor_id: string;
  actor_type: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LedgerEntryDto {
  id: string;
  financialTransactionId: string | null;
  tenantId: string;
  accountId: string;
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amount: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  description: string;
  reason: string | null;
  actorId: string;
  actorType: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FinancialAdjustmentRow {
  id: string;
  tenant_id: string;
  amount: string | number;
  currency: string;
  type: FinancialAdjustmentType;
  reason: string;
  status: FinancialAdjustmentStatus;
  actor_id: string;
  actor_type: string;
  idempotency_key: string | null;
  created_at: Date;
}

export interface FinancialAdjustmentDto {
  id: string;
  tenantId: string;
  amount: number;
  currency: string;
  type: FinancialAdjustmentType;
  reason: string;
  status: FinancialAdjustmentStatus;
  actorId: string;
  actorType: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface SettlementRow {
  id: string;
  tenant_id: string;
  period_start: Date;
  period_end: Date;
  currency: string;
  gross_amount: string | number;
  commission_amount: string | number;
  fee_amount: string | number;
  refund_amount: string | number;
  adjustment_amount: string | number;
  net_payable_amount: string | number;
  status: SettlementStatus;
  idempotency_key: string | null;
  snapshot_data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SettlementDto {
  id: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossAmount: number;
  commissionAmount: number;
  feeAmount: number;
  refundAmount: number;
  adjustmentAmount: number;
  netPayableAmount: number;
  status: SettlementStatus;
  idempotencyKey: string | null;
  snapshotData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  items?: SettlementItemDto[] | undefined;
}

export interface SettlementItemRow {
  id: string;
  settlement_id: string;
  ledger_entry_id: string;
  created_at: Date;
}

export interface SettlementItemDto {
  id: string;
  settlementId: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface FinancialSummaryDto {
  tenantId: string;
  currency: string;
  currentBalance: number;
  pendingBalance: number;
  settledBalance: number;
  totalEarnings: number;
  totalCommissions: number;
  totalFees: number;
  totalRefunds: number;
  totalAdjustments: number;
  ledgerCount: number;
}

export interface IngestOrderFinancialsInput {
  sellerOrderId: string;
  commissionRate?: number | undefined; // e.g. 0.10 for 10%
  feeAmount?: number | undefined;
  idempotencyKey?: string | undefined;
}

export interface IngestRefundFinancialsInput {
  merchantId: string;
  refundId: string;
  sellerOrderId?: string | undefined;
  refundAmount: number;
  commissionRefundAmount?: number | undefined;
  currency: string;
  reason?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface CreateAdjustmentInput {
  merchantId: string;
  amount: number;
  currency: string;
  type: FinancialAdjustmentType;
  reason: string;
  idempotencyKey?: string | undefined;
}

export interface CalculateSettlementInput {
  merchantId: string;
  periodStart: string | Date;
  periodEnd: string | Date;
  currency: string;
  idempotencyKey?: string | undefined;
}

export interface TransitionSettlementInput {
  targetStatus: SettlementStatus;
  reason?: string | undefined;
  failureReason?: string | undefined;
}

export interface ListLedgerEntriesFilter {
  entryType?: LedgerEntryType | undefined;
  sourceType?: string | undefined;
  sourceId?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
