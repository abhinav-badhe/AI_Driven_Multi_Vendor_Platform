import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import type { OrderService } from '../../orders/index.js';
import type { PaymentService } from '../../payment/index.js';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { SettlementRepository } from './settlement-repository.js';
import type {
  FinancialAccountRow,
  FinancialAccountType,
  FinancialTransactionRow,
  FinancialTransactionType,
  LedgerEntryRow,
  LedgerEntryDto,
  LedgerEntryType,
  LedgerDirection,
  FinancialAdjustmentRow,
  FinancialAdjustmentDto,
  SettlementRow,
  SettlementDto,
  FinancialSummaryDto,
  IngestOrderFinancialsInput,
  IngestRefundFinancialsInput,
  CreateAdjustmentInput,
  CalculateSettlementInput,
  TransitionSettlementInput,
  ListLedgerEntriesFilter,
  SettlementStatus,
} from './types.js';

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

const VALID_SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  PENDING: ['CALCULATED'],
  CALCULATED: ['APPROVED', 'REJECTED'],
  APPROVED: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['SETTLED', 'FAILED'],
  FAILED: ['PROCESSING', 'REJECTED'],
  SETTLED: [],
  REJECTED: [],
};

export class SettlementService {
  private readonly repo: SettlementRepository;
  private readonly db: DatabaseConnection;
  private readonly activeLocks = new Map<string, Promise<void>>();

  constructor(
    db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
  ) {
    this.repo = new SettlementRepository(db);
    this.db = db;
    this.logger.debug('SettlementService initialized');
  }

  getPaymentService(): PaymentService {
    return this.paymentService;
  }

  private async acquireLock(lockKey: string): Promise<() => void> {
    while (this.activeLocks.has(lockKey)) {
      await this.activeLocks.get(lockKey);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.activeLocks.set(lockKey, lockPromise);

    return () => {
      this.activeLocks.delete(lockKey);
      resolveLock();
    };
  }

  private async getOrCreateAccount(
    txRepo: SettlementRepository,
    tenantId: string,
    currency: string,
    accountType: FinancialAccountType = 'MERCHANT_BALANCE',
  ): Promise<FinancialAccountRow> {
    let account = await txRepo.findAccountByMerchantAndCurrencyForUpdate(tenantId, currency, accountType);
    if (!account) {
      account = await txRepo.createAccount({
        id: randomUUID(),
        tenantId,
        currency,
        accountType,
      });
      // Re-query with FOR UPDATE to hold lock
      account = await txRepo.findAccountByMerchantAndCurrencyForUpdate(tenantId, currency, accountType);
    }
    return account!;
  }

  /**
   * Universal Double-Entry Journal Posting Boundary
   * Enforces:
   * 1. Immutable Financial Transaction record
   * 2. SUM(DEBIT) === SUM(CREDIT) across all entries
   * 3. Single currency per journal (no cross-currency imbalance)
   * 4. Positive entry amounts (> 0)
   * 5. Atomicity between journal creation, ledger entries, and account balance updates
   */
  public async postJournal(
    input: {
      tenantId: string;
      transactionType: FinancialTransactionType;
      sourceType: string;
      sourceId: string;
      currency: string;
      idempotencyKey?: string | null;
      description?: string;
      metadata?: Record<string, unknown>;
      entries: Array<{
        tenantId: string;
        accountId: string;
        entryType: LedgerEntryType;
        direction: LedgerDirection;
        amount: number;
        currency: string;
        description: string;
        reason?: string | null;
        actorId?: string | null;
        actorType?: string | null;
        idempotencyKey?: string | null;
        metadata?: Record<string, unknown>;
      }>;
    },
    txConnection?: DatabaseConnection,
  ): Promise<{ transaction: FinancialTransactionRow; entries: LedgerEntryRow[] }> {
    const runInTx = async (tx: DatabaseConnection) => {
      const txRepo = new SettlementRepository(tx);

      // Invariant 1: Double-entry requires at least 2 entries
      if (!input.entries || input.entries.length < 2) {
        throw new ValidationError('A financial journal must contain at least 2 entries (double-entry)');
      }

      // Invariant 2 & 3: Positive amounts, single currency, and balanced SUM(DEBIT) = SUM(CREDIT)
      let sumDebit = 0;
      let sumCredit = 0;

      for (const entry of input.entries) {
        if (typeof entry.amount !== 'number' || isNaN(entry.amount) || entry.amount <= 0) {
          throw new ValidationError(`Journal entry amount must be greater than zero: got ${entry.amount}`);
        }
        if (entry.currency !== input.currency) {
          throw new ValidationError(
            `Cross-currency journal entry rejected: expected ${input.currency} but got ${entry.currency}`,
          );
        }
        if (entry.direction === 'DEBIT') {
          sumDebit = round2(sumDebit + entry.amount);
        } else if (entry.direction === 'CREDIT') {
          sumCredit = round2(sumCredit + entry.amount);
        } else {
          throw new ValidationError(`Invalid ledger entry direction: ${entry.direction}`);
        }
      }

      if (round2(sumDebit) !== round2(sumCredit)) {
        throw new ValidationError(
          `Unbalanced journal entry: SUM(DEBIT) = ${sumDebit} !== SUM(CREDIT) = ${sumCredit}`,
        );
      }

      // Idempotency check by key
      if (input.idempotencyKey) {
        const existingTx = await txRepo.findFinancialTransactionByIdempotency(
          input.tenantId,
          input.idempotencyKey,
        );
        if (existingTx) {
          if (
            existingTx.currency !== input.currency ||
            existingTx.transaction_type !== input.transactionType
          ) {
            throw new ConflictError(
              'Financial transaction idempotency key reused with different parameters',
            );
          }
          const existingEntries = await txRepo.listLedgerEntriesByFinancialTransactionId(existingTx.id);
          return { transaction: existingTx, entries: existingEntries };
        }
      }

      // Deduplication check by source & transaction type
      const existingBySource = await txRepo.findFinancialTransactionBySource(
        input.sourceType,
        input.sourceId,
        input.transactionType,
      );
      if (existingBySource) {
        const existingEntries = await txRepo.listLedgerEntriesByFinancialTransactionId(existingBySource.id);
        return { transaction: existingBySource, entries: existingEntries };
      }

      // Create Financial Transaction (Journal Header)
      const txId = randomUUID();
      const transaction = await txRepo.createFinancialTransaction({
        id: txId,
        tenantId: input.tenantId,
        transactionType: input.transactionType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? {},
      });

      // Insert Ledger Entries referencing the financial transaction
      const insertedEntries: LedgerEntryRow[] = [];
      for (const entry of input.entries) {
        const entryRow = await txRepo.insertLedgerEntry({
          id: randomUUID(),
          financialTransactionId: txId,
          tenantId: entry.tenantId,
          accountId: entry.accountId,
          entryType: entry.entryType,
          direction: entry.direction,
          amount: entry.amount,
          currency: entry.currency,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          description: entry.description,
          reason: entry.reason ?? null,
          actorId: entry.actorId ?? 'SYSTEM',
          actorType: entry.actorType ?? 'SYSTEM',
          idempotencyKey: entry.idempotencyKey ?? null,
          metadata: entry.metadata ?? {},
        });
        insertedEntries.push(entryRow);
      }

      // Aggregate balance updates per account
      const accountDeltas = new Map<string, { netDebit: number; netCredit: number }>();
      for (const entry of input.entries) {
        const current = accountDeltas.get(entry.accountId) ?? { netDebit: 0, netCredit: 0 };
        if (entry.direction === 'DEBIT') {
          current.netDebit = round2(current.netDebit + entry.amount);
        } else {
          current.netCredit = round2(current.netCredit + entry.amount);
        }
        accountDeltas.set(entry.accountId, current);
      }

      // Apply balance updates atomically with optimistic locking
      for (const [accountId, delta] of accountDeltas.entries()) {
        const account = await txRepo.findAccountByIdForUpdate(accountId);
        if (!account) {
          throw new NotFoundError(`Financial account '${accountId}' not found`);
        }

        let balanceChange = 0;
        let settledChange = 0;

        if (account.account_type === 'MERCHANT_BALANCE') {
          // Merchant Balance: Credit increases (+), Debit decreases (-)
          balanceChange = round2(delta.netCredit - delta.netDebit);
          if (input.transactionType === 'PAYOUT') {
            settledChange = delta.netDebit;
          }
        } else if (account.account_type === 'CLEARING') {
          // Platform Clearing: Debit increases (+), Credit decreases (-)
          balanceChange = round2(delta.netDebit - delta.netCredit);
        } else if (
          account.account_type === 'COMMISSION_REVENUE' ||
          account.account_type === 'FEE_REVENUE'
        ) {
          // Platform Revenue: Credit increases revenue (+), Debit decreases (-)
          balanceChange = round2(delta.netCredit - delta.netDebit);
        } else if (account.account_type === 'PAYOUT_CASH') {
          // Platform Cash: Debit increases (+), Credit (payout outflow) decreases (-)
          balanceChange = round2(delta.netDebit - delta.netCredit);
        }

        const newCurrent = round2(Number(account.current_balance) + balanceChange);
        const newSettled = round2(Number(account.settled_balance) + settledChange);

        await txRepo.updateAccountBalances({
          accountId: account.id,
          currentBalance: newCurrent,
          pendingBalance: Number(account.pending_balance),
          settledBalance: newSettled,
          expectedVersion: account.version,
        });
      }

      return { transaction, entries: insertedEntries };
    };

    if (txConnection) {
      return await runInTx(txConnection);
    }
    return await this.db.withTransaction(runInTx);
  }

  // 1. Ingest Order Financial Facts (Multi-Vendor Attribution & Platform Commission)
  async ingestOrderFinancials(
    actor: AuthorizedActor,
    input: IngestOrderFinancialsInput,
  ): Promise<{ earningEntry: LedgerEntryDto; commissionEntry: LedgerEntryDto; feeEntry?: LedgerEntryDto | undefined }> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
    const sellerOrder = await this.orderService.getSellerOrder(adminActor, input.sellerOrderId);
    if (!sellerOrder) {
      throw new NotFoundError(`Seller order '${input.sellerOrderId}' not found`);
    }

    const merchantId = sellerOrder.sellerTenantId;
    const currency = sellerOrder.currency;
    const grossAmount = round2(sellerOrder.totalAmount / 100);
    const commissionRate = input.commissionRate ?? 0.10; // default 10%
    const commissionAmount = round2(grossAmount * commissionRate);
    const feeAmount = round2(input.feeAmount ?? 0);

    if (grossAmount <= 0) {
      throw new ValidationError('Order total amount must be greater than zero');
    }

    const lockKey = `seller_fin_${merchantId}_${currency}`;
    const releaseLock = await this.acquireLock(lockKey);

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new SettlementRepository(tx);
        const platformTenantId = await txRepo.getPlatformTenantId();

        // Deduplication check on existing order earning
        const existingEarning = await txRepo.findLedgerEntryBySourceAndType(
          merchantId,
          'ORDER',
          sellerOrder.id,
          'EARNING',
        );
        if (existingEarning) {
          const existingCommission = await txRepo.findLedgerEntryBySourceAndType(
            merchantId,
            'ORDER',
            sellerOrder.id,
            'COMMISSION',
          );
          const existingFee = await txRepo.findLedgerEntryBySourceAndType(
            merchantId,
            'ORDER',
            sellerOrder.id,
            'FEE',
          );
          return {
            earningEntry: this.toLedgerEntryDto(existingEarning),
            commissionEntry: this.toLedgerEntryDto(existingCommission!),
            feeEntry: existingFee ? this.toLedgerEntryDto(existingFee) : undefined,
          };
        }

        // Idempotency check if key provided
        if (input.idempotencyKey) {
          const existingByKey = await txRepo.findLedgerEntryByIdempotency(merchantId, input.idempotencyKey);
          if (existingByKey) {
            if (
              existingByKey.tenant_id !== merchantId ||
              Number(existingByKey.amount) !== grossAmount ||
              existingByKey.currency !== currency
            ) {
              throw new ConflictError(
                'Idempotency key already used for a different financial transaction payload',
              );
            }
            const existingCommission = await txRepo.findLedgerEntryBySourceAndType(
              merchantId,
              'ORDER',
              sellerOrder.id,
              'COMMISSION',
            );
            return {
              earningEntry: this.toLedgerEntryDto(existingByKey),
              commissionEntry: this.toLedgerEntryDto(existingCommission!),
            };
          }
        }

        // Accounts setup
        const merchantAccount = await this.getOrCreateAccount(txRepo, merchantId, currency, 'MERCHANT_BALANCE');
        const platformClearing = await this.getOrCreateAccount(txRepo, platformTenantId, currency, 'CLEARING');
        const platformCommission = await this.getOrCreateAccount(txRepo, platformTenantId, currency, 'COMMISSION_REVENUE');
        const platformFee = await this.getOrCreateAccount(txRepo, platformTenantId, currency, 'FEE_REVENUE');

        // 1. ORDER_EARNING Journal: Debit Platform Clearing, Credit Merchant Balance
        const earningResult = await this.postJournal(
          {
            tenantId: merchantId,
            transactionType: 'ORDER_EARNING',
            sourceType: 'ORDER',
            sourceId: sellerOrder.id,
            currency,
            idempotencyKey: input.idempotencyKey ?? null,
            description: `Gross merchandise earning for seller order ${sellerOrder.id}`,
            metadata: {
              customerOrderId: sellerOrder.customerOrderId,
              sellerOrderId: sellerOrder.id,
              subtotalAmount: sellerOrder.subtotalAmount,
              shippingAmount: sellerOrder.shippingAmount,
              taxAmount: sellerOrder.taxAmount,
            },
            entries: [
              {
                tenantId: platformTenantId,
                accountId: platformClearing.id,
                entryType: 'CLEARING',
                direction: 'DEBIT',
                amount: grossAmount,
                currency,
                description: `Platform clearing (liability) for seller order ${sellerOrder.id}`,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: { sellerOrderId: sellerOrder.id },
              },
              {
                tenantId: merchantId,
                accountId: merchantAccount.id,
                entryType: 'EARNING',
                direction: 'CREDIT',
                amount: grossAmount,
                currency,
                description: `Gross merchandise earning for seller order ${sellerOrder.id}`,
                actorId: actor.userId,
                actorType: actor.role,
                idempotencyKey: input.idempotencyKey ?? null,
                metadata: {
                  customerOrderId: sellerOrder.customerOrderId,
                  sellerOrderId: sellerOrder.id,
                  subtotalAmount: sellerOrder.subtotalAmount,
                  shippingAmount: sellerOrder.shippingAmount,
                  taxAmount: sellerOrder.taxAmount,
                },
              },
            ],
          },
          tx,
        );

        // 2. COMMISSION Journal: Debit Merchant Balance, Credit Platform Commission Revenue
        const commissionResult = await this.postJournal(
          {
            tenantId: merchantId,
            transactionType: 'COMMISSION',
            sourceType: 'ORDER',
            sourceId: sellerOrder.id,
            currency,
            description: `Platform commission for seller order ${sellerOrder.id}`,
            metadata: { sellerOrderId: sellerOrder.id, commissionRate },
            entries: [
              {
                tenantId: merchantId,
                accountId: merchantAccount.id,
                entryType: 'COMMISSION',
                direction: 'DEBIT',
                amount: commissionAmount,
                currency,
                description: `Platform commission for seller order ${sellerOrder.id}`,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: { sellerOrderId: sellerOrder.id, commissionRate },
              },
              {
                tenantId: platformTenantId,
                accountId: platformCommission.id,
                entryType: 'COMMISSION_REVENUE',
                direction: 'CREDIT',
                amount: commissionAmount,
                currency,
                description: `Platform commission revenue for seller order ${sellerOrder.id}`,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: { sellerOrderId: sellerOrder.id, commissionRate },
              },
            ],
          },
          tx,
        );

        // 3. FEE Journal (if feeAmount > 0): Debit Merchant Balance, Credit Platform Fee Revenue
        let feeResult: { transaction: FinancialTransactionRow; entries: LedgerEntryRow[] } | undefined;
        if (feeAmount > 0) {
          feeResult = await this.postJournal(
            {
              tenantId: merchantId,
              transactionType: 'FEE',
              sourceType: 'ORDER',
              sourceId: sellerOrder.id,
              currency,
              description: `Platform fee for seller order ${sellerOrder.id}`,
              metadata: { sellerOrderId: sellerOrder.id },
              entries: [
                {
                  tenantId: merchantId,
                  accountId: merchantAccount.id,
                  entryType: 'FEE',
                  direction: 'DEBIT',
                  amount: feeAmount,
                  currency,
                  description: `Platform fee for seller order ${sellerOrder.id}`,
                  actorId: actor.userId,
                  actorType: actor.role,
                  metadata: { sellerOrderId: sellerOrder.id },
                },
                {
                  tenantId: platformTenantId,
                  accountId: platformFee.id,
                  entryType: 'FEE_REVENUE',
                  direction: 'CREDIT',
                  amount: feeAmount,
                  currency,
                  description: `Platform fee revenue for seller order ${sellerOrder.id}`,
                  actorId: actor.userId,
                  actorType: actor.role,
                  metadata: { sellerOrderId: sellerOrder.id },
                },
              ],
            },
            tx,
          );
        }

        const earningRow = earningResult.entries.find((e) => e.tenant_id === merchantId)!;
        const commissionRow = commissionResult.entries.find((e) => e.tenant_id === merchantId)!;
        const feeRow = feeResult?.entries.find((e) => e.tenant_id === merchantId);

        return {
          earningEntry: this.toLedgerEntryDto(earningRow),
          commissionEntry: this.toLedgerEntryDto(commissionRow),
          feeEntry: feeRow ? this.toLedgerEntryDto(feeRow) : undefined,
        };
      });
    } finally {
      releaseLock();
    }
  }

  // 2. Ingest Refund Financial Facts (Compensating Ledger Entries & Cumulative Overflow Protection)
  async ingestRefundFinancials(
    actor: AuthorizedActor,
    input: IngestRefundFinancialsInput,
  ): Promise<{ refundEntry: LedgerEntryDto; commissionReversalEntry?: LedgerEntryDto | undefined }> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const refundAmount = round2(
      input.refundAmount > 100 && Number.isInteger(input.refundAmount)
        ? input.refundAmount / 100
        : input.refundAmount,
    );
    const commissionReversal = input.commissionRefundAmount
      ? round2(
          input.commissionRefundAmount > 100 && Number.isInteger(input.commissionRefundAmount)
            ? input.commissionRefundAmount / 100
            : input.commissionRefundAmount,
        )
      : 0;

    if (refundAmount <= 0) {
      throw new ValidationError('Refund amount must be greater than zero');
    }

    const lockKey = `seller_fin_${input.merchantId}_${input.currency}`;
    const releaseLock = await this.acquireLock(lockKey);

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new SettlementRepository(tx);

        // Deduplication check on refund source
        const existingRefund = await txRepo.findLedgerEntryBySourceAndType(
          input.merchantId,
          'REFUND',
          input.refundId,
          'REFUND',
        );
        if (existingRefund) {
          const existingCommissionRev = await txRepo.findLedgerEntryBySourceAndType(
            input.merchantId,
            'REFUND',
            input.refundId,
            'COMMISSION',
          );
          return {
            refundEntry: this.toLedgerEntryDto(existingRefund),
            commissionReversalEntry: existingCommissionRev
              ? this.toLedgerEntryDto(existingCommissionRev)
              : undefined,
          };
        }

        // Idempotency check if key provided
        if (input.idempotencyKey) {
          const existingByKey = await txRepo.findLedgerEntryByIdempotency(input.merchantId, input.idempotencyKey);
          if (existingByKey) {
            if (
              existingByKey.tenant_id !== input.merchantId ||
              Number(existingByKey.amount) !== refundAmount ||
              existingByKey.currency !== input.currency
            ) {
              throw new ConflictError(
                'Idempotency key already used for a different refund payload',
              );
            }
            return {
              refundEntry: this.toLedgerEntryDto(existingByKey),
            };
          }
        }

        // Transaction-safe Cumulative Refund Protection (Invariant 10 / Test K)
        if (input.sellerOrderId) {
          const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
          const sellerOrder = await this.orderService.getSellerOrder(adminActor, input.sellerOrderId);
          if (!sellerOrder) {
            throw new NotFoundError(`Seller order '${input.sellerOrderId}' not found`);
          }
          const orderGross = round2(sellerOrder.totalAmount / 100);
          const priorRefunded = await txRepo.getSumRefundsForSellerOrder(input.sellerOrderId);
          const cumulativeRefund = round2(priorRefunded + refundAmount);
          if (cumulativeRefund > orderGross) {
            throw new ValidationError(
              `Cumulative refund (${cumulativeRefund} ${input.currency}) exceeds original refundable amount (${orderGross} ${input.currency})`,
            );
          }
        }

        const platformTenantId = await txRepo.getPlatformTenantId();

        // Accounts setup
        const merchantAccount = await this.getOrCreateAccount(txRepo, input.merchantId, input.currency, 'MERCHANT_BALANCE');
        const platformClearing = await this.getOrCreateAccount(txRepo, platformTenantId, input.currency, 'CLEARING');
        const platformCommission = await this.getOrCreateAccount(txRepo, platformTenantId, input.currency, 'COMMISSION_REVENUE');

        // 1. REFUND Journal: Debit Merchant Balance, Credit Platform Clearing
        const refundResult = await this.postJournal(
          {
            tenantId: input.merchantId,
            transactionType: 'REFUND',
            sourceType: 'REFUND',
            sourceId: input.refundId,
            currency: input.currency,
            idempotencyKey: input.idempotencyKey ?? null,
            description: `Customer refund compensation for refund ${input.refundId}`,
            metadata: {
              sellerOrderId: input.sellerOrderId,
              refundId: input.refundId,
            },
            entries: [
              {
                tenantId: input.merchantId,
                accountId: merchantAccount.id,
                entryType: 'REFUND',
                direction: 'DEBIT',
                amount: refundAmount,
                currency: input.currency,
                description: `Customer refund compensation for refund ${input.refundId}`,
                reason: input.reason ?? null,
                actorId: actor.userId,
                actorType: actor.role,
                idempotencyKey: input.idempotencyKey ?? null,
                metadata: {
                  sellerOrderId: input.sellerOrderId,
                  refundId: input.refundId,
                },
              },
              {
                tenantId: platformTenantId,
                accountId: platformClearing.id,
                entryType: 'CLEARING',
                direction: 'CREDIT',
                amount: refundAmount,
                currency: input.currency,
                description: `Platform clearing reversal for refund ${input.refundId}`,
                reason: input.reason ?? null,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: {
                  sellerOrderId: input.sellerOrderId,
                  refundId: input.refundId,
                },
              },
            ],
          },
          tx,
        );

        // 2. COMMISSION_REVERSAL Journal (if commissionReversal > 0): Debit Platform Commission Revenue, Credit Merchant Balance
        let commRevResult: { transaction: FinancialTransactionRow; entries: LedgerEntryRow[] } | undefined;
        if (commissionReversal > 0) {
          commRevResult = await this.postJournal(
            {
              tenantId: input.merchantId,
              transactionType: 'COMMISSION_REVERSAL',
              sourceType: 'REFUND',
              sourceId: input.refundId,
              currency: input.currency,
              description: `Platform commission reimbursement for refund ${input.refundId}`,
              metadata: { refundId: input.refundId },
              entries: [
                {
                  tenantId: platformTenantId,
                  accountId: platformCommission.id,
                  entryType: 'COMMISSION_REVENUE',
                  direction: 'DEBIT',
                  amount: commissionReversal,
                  currency: input.currency,
                  description: `Platform commission revenue reversal for refund ${input.refundId}`,
                  actorId: actor.userId,
                  actorType: actor.role,
                  metadata: { refundId: input.refundId },
                },
                {
                  tenantId: input.merchantId,
                  accountId: merchantAccount.id,
                  entryType: 'COMMISSION',
                  direction: 'CREDIT',
                  amount: commissionReversal,
                  currency: input.currency,
                  description: `Platform commission reimbursement for refund ${input.refundId}`,
                  actorId: actor.userId,
                  actorType: actor.role,
                  metadata: { refundId: input.refundId },
                },
              ],
            },
            tx,
          );
        }

        const refundRow = refundResult.entries.find((e) => e.tenant_id === input.merchantId)!;
        const commRevRow = commRevResult?.entries.find((e) => e.tenant_id === input.merchantId);

        return {
          refundEntry: this.toLedgerEntryDto(refundRow),
          commissionReversalEntry: commRevRow ? this.toLedgerEntryDto(commRevRow) : undefined,
        };
      });
    } finally {
      releaseLock();
    }
  }

  // 3. Create Approved Financial Adjustment
  async createAdjustment(
    actor: AuthorizedActor,
    input: CreateAdjustmentInput,
  ): Promise<{ adjustment: FinancialAdjustmentDto; ledgerEntry: LedgerEntryDto }> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const amount = round2(input.amount);
    if (amount <= 0) {
      throw new ValidationError('Adjustment amount must be greater than zero');
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new ValidationError('Adjustment reason is required');
    }

    const lockKey = `seller_fin_${input.merchantId}_${input.currency}`;
    const releaseLock = await this.acquireLock(lockKey);

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new SettlementRepository(tx);

        // Idempotency check
        if (input.idempotencyKey) {
          const existingAdj = await txRepo.findAdjustmentByIdempotency(
            input.merchantId,
            input.idempotencyKey,
          );
          if (existingAdj) {
            if (
              Number(existingAdj.amount) !== amount ||
              existingAdj.currency !== input.currency ||
              existingAdj.type !== input.type
            ) {
              throw new ConflictError(
                'Adjustment idempotency key reused with different amount, currency, or type',
              );
            }
            const existingEntry = await txRepo.findLedgerEntryBySourceAndType(
              input.merchantId,
              'ADJUSTMENT',
              existingAdj.id,
              'ADJUSTMENT',
            );
            return {
              adjustment: this.toAdjustmentDto(existingAdj),
              ledgerEntry: this.toLedgerEntryDto(existingEntry!),
            };
          }
        }

        const platformTenantId = await txRepo.getPlatformTenantId();

        // Accounts setup
        const merchantAccount = await this.getOrCreateAccount(txRepo, input.merchantId, input.currency, 'MERCHANT_BALANCE');
        const platformClearing = await this.getOrCreateAccount(txRepo, platformTenantId, input.currency, 'CLEARING');

        const adjId = randomUUID();
        const adjRow = await txRepo.createAdjustment({
          id: adjId,
          tenantId: input.merchantId,
          amount,
          currency: input.currency,
          type: input.type,
          reason: input.reason,
          status: 'APPROVED',
          actorId: actor.userId,
          actorType: actor.role,
          idempotencyKey: input.idempotencyKey ?? null,
        });

        // Direction mapping: CREDIT adjustment credits merchant, debits platform clearing
        // DEBIT adjustment debits merchant, credits platform clearing
        const merchantDirection = input.type;
        const platformDirection = input.type === 'CREDIT' ? 'DEBIT' : 'CREDIT';

        const adjResult = await this.postJournal(
          {
            tenantId: input.merchantId,
            transactionType: 'ADJUSTMENT',
            sourceType: 'ADJUSTMENT',
            sourceId: adjId,
            currency: input.currency,
            idempotencyKey: input.idempotencyKey ?? null,
            description: `Financial adjustment: ${input.reason}`,
            metadata: { adjustmentId: adjId, type: input.type },
            entries: [
              {
                tenantId: input.merchantId,
                accountId: merchantAccount.id,
                entryType: 'ADJUSTMENT',
                direction: merchantDirection,
                amount,
                currency: input.currency,
                description: `Financial adjustment: ${input.reason}`,
                reason: input.reason,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: { adjustmentId: adjId, type: input.type },
              },
              {
                tenantId: platformTenantId,
                accountId: platformClearing.id,
                entryType: 'ADJUSTMENT',
                direction: platformDirection,
                amount,
                currency: input.currency,
                description: `Platform offsetting financial adjustment: ${input.reason}`,
                reason: input.reason,
                actorId: actor.userId,
                actorType: actor.role,
                metadata: { adjustmentId: adjId, type: input.type },
              },
            ],
          },
          tx,
        );

        const entryRow = adjResult.entries.find((e) => e.tenant_id === input.merchantId)!;

        return {
          adjustment: this.toAdjustmentDto(adjRow),
          ledgerEntry: this.toLedgerEntryDto(entryRow),
        };
      });
    } finally {
      releaseLock();
    }
  }

  // 4. Calculate Settlement Period & Create Settlement Record
  async calculateSettlement(
    actor: AuthorizedActor,
    input: CalculateSettlementInput,
  ): Promise<SettlementDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (periodEnd.getTime() < periodStart.getTime()) {
      throw new ValidationError('Period end cannot be earlier than period start');
    }

    const lockKey = `seller_fin_${input.merchantId}_${input.currency}`;
    const releaseLock = await this.acquireLock(lockKey);

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new SettlementRepository(tx);

        // Idempotency check
        if (input.idempotencyKey) {
          const existing = await txRepo.findSettlementByIdempotency(
            input.merchantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (
              existing.currency !== input.currency ||
              new Date(existing.period_start).getTime() !== periodStart.getTime() ||
              new Date(existing.period_end).getTime() !== periodEnd.getTime()
            ) {
              throw new ConflictError(
                'Settlement idempotency key reused with different period or currency',
              );
            }
            const items = await txRepo.findSettlementItems(existing.id);
            return this.toSettlementDto(existing, items);
          }
        }

        // Row lock on seller financial account
        await this.getOrCreateAccount(txRepo, input.merchantId, input.currency, 'MERCHANT_BALANCE');

        // Fetch unsettled ledger entries in range
        const entries = await txRepo.findUnsettledLedgerEntries(
          input.merchantId,
          input.currency,
          periodStart,
          periodEnd,
        );

        let grossAmount = 0;
        let commissionAmount = 0;
        let feeAmount = 0;
        let refundAmount = 0;
        let adjustmentAmount = 0;

        for (const entry of entries) {
          const amt = Number(entry.amount);
          if (entry.entry_type === 'EARNING') {
            grossAmount = round2(grossAmount + amt);
          } else if (entry.entry_type === 'COMMISSION') {
            if (entry.direction === 'DEBIT') {
              commissionAmount = round2(commissionAmount + amt);
            } else {
              commissionAmount = round2(commissionAmount - amt);
            }
          } else if (entry.entry_type === 'FEE') {
            feeAmount = round2(feeAmount + amt);
          } else if (entry.entry_type === 'REFUND') {
            refundAmount = round2(refundAmount + amt);
          } else if (entry.entry_type === 'ADJUSTMENT') {
            if (entry.direction === 'CREDIT') {
              adjustmentAmount = round2(adjustmentAmount + amt);
            } else {
              adjustmentAmount = round2(adjustmentAmount - amt);
            }
          }
        }

        const netPayable = round2(
          grossAmount - commissionAmount - feeAmount - refundAmount + adjustmentAmount,
        );

        const settlementId = randomUUID();
        const snapshotData = {
          entryCount: entries.length,
          ledgerEntryIds: entries.map((e) => e.id),
          summary: {
            grossAmount,
            commissionAmount,
            feeAmount,
            refundAmount,
            adjustmentAmount,
            netPayable,
          },
          calculatedAt: new Date().toISOString(),
          calculatedBy: actor.userId,
        };

        const settlementRow = await txRepo.createSettlement({
          id: settlementId,
          tenantId: input.merchantId,
          periodStart,
          periodEnd,
          currency: input.currency,
          grossAmount,
          commissionAmount,
          feeAmount,
          refundAmount,
          adjustmentAmount,
          netPayableAmount: netPayable,
          status: 'CALCULATED',
          idempotencyKey: input.idempotencyKey ?? null,
          snapshotData,
        });

        // Link settlement items
        const itemRows = entries.map((entry) => ({
          id: randomUUID(),
          settlementId,
          ledgerEntryId: entry.id,
        }));
        await txRepo.linkSettlementItems(itemRows);

        const items = await txRepo.findSettlementItems(settlementId);
        return this.toSettlementDto(settlementRow, items);
      });
    } finally {
      releaseLock();
    }
  }

  // 5. State Machine Transition for Settlements (Double-Entry Payout Posting)
  async transitionSettlementStatus(
    actor: AuthorizedActor,
    settlementId: string,
    input: TransitionSettlementInput,
  ): Promise<SettlementDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const initialSettlement = await this.repo.findSettlementById(settlementId);
    if (!initialSettlement) {
      throw new NotFoundError(`Settlement '${settlementId}' not found`);
    }

    const lockKey = `seller_fin_${initialSettlement.tenant_id}_${initialSettlement.currency}`;
    const releaseLock = await this.acquireLock(lockKey);

    try {
      return await this.db.withTransaction(async (tx) => {
        const txRepo = new SettlementRepository(tx);

        // Row lock on settlement
        const settlement = await txRepo.findSettlementByIdForUpdate(settlementId);
        if (!settlement) {
          throw new NotFoundError(`Settlement '${settlementId}' not found`);
        }

        const currentStatus = settlement.status;

        // Idempotent retry: if settlement is already at the targetStatus, return existing state
        if (currentStatus === input.targetStatus) {
          const items = await txRepo.findSettlementItems(settlementId);
          return this.toSettlementDto(settlement, items);
        }

        const allowed = VALID_SETTLEMENT_TRANSITIONS[currentStatus] ?? [];
        if (!allowed.includes(input.targetStatus)) {
          throw new InvalidStateTransitionError(
            `Invalid settlement state transition from '${currentStatus}' to '${input.targetStatus}'. Allowed: ${allowed.join(', ') || 'none'}`,
          );
        }

        // If target status is SETTLED, execute genuine double-entry payout posting
        if (input.targetStatus === 'SETTLED') {
          const netPayable = Number(settlement.net_payable_amount);

          if (netPayable > 0) {
            const platformTenantId = await txRepo.getPlatformTenantId();

            // Lock & fetch both accounts
            const merchantAccount = await this.getOrCreateAccount(
              txRepo,
              settlement.tenant_id,
              settlement.currency,
              'MERCHANT_BALANCE',
            );
            const platformAccount = await this.getOrCreateAccount(
              txRepo,
              platformTenantId,
              settlement.currency,
              'PAYOUT_CASH',
            );

            // Genuine Double-Entry Payout:
            // Merchant Seller Balance: DEBIT netPayable
            // Platform Cash/Bank: CREDIT netPayable
            await this.postJournal(
              {
                tenantId: settlement.tenant_id,
                transactionType: 'PAYOUT',
                sourceType: 'SETTLEMENT',
                sourceId: settlement.id,
                currency: settlement.currency,
                description: `Settlement payout for period ${settlement.period_start.toISOString()} - ${settlement.period_end.toISOString()}`,
                metadata: {
                  settlementId: settlement.id,
                  netPayableAmount: netPayable,
                },
                entries: [
                  {
                    tenantId: settlement.tenant_id,
                    accountId: merchantAccount.id,
                    entryType: 'PAYOUT',
                    direction: 'DEBIT',
                    amount: netPayable,
                    currency: settlement.currency,
                    description: `Settlement payout for period ${settlement.period_start.toISOString()} - ${settlement.period_end.toISOString()}`,
                    actorId: actor.userId,
                    actorType: actor.role,
                    metadata: {
                      settlementId: settlement.id,
                      netPayableAmount: netPayable,
                    },
                  },
                  {
                    tenantId: platformTenantId,
                    accountId: platformAccount.id,
                    entryType: 'PAYOUT',
                    direction: 'CREDIT',
                    amount: netPayable,
                    currency: settlement.currency,
                    description: `Platform cash payout credit for settlement ${settlement.id}`,
                    actorId: actor.userId,
                    actorType: actor.role,
                    metadata: {
                      settlementId: settlement.id,
                      netPayableAmount: netPayable,
                    },
                  },
                ],
              },
              tx,
            );
          }
        }

        const updatedSnapshot: Record<string, unknown> = {
          ...(settlement.snapshot_data ?? {}),
          lastTransition: {
            from: currentStatus,
            to: input.targetStatus,
            at: new Date().toISOString(),
            actor: actor.userId,
            reason: input.reason ?? null,
            failureReason: input.failureReason ?? null,
          },
        };

        const updated = await txRepo.updateSettlementStatus(
          settlementId,
          [currentStatus],
          input.targetStatus,
          updatedSnapshot,
        );

        if (!updated) {
          throw new ConflictError(`Settlement status changed concurrently`);
        }

        const items = await txRepo.findSettlementItems(settlementId);
        return this.toSettlementDto(updated, items);
      });
    } finally {
      releaseLock();
    }
  }

  // 6. Read Queries: Financial Summary, Ledger History, Settlement Details
  async getFinancialSummary(
    actor: AuthorizedActor,
    merchantId: string,
    currency = 'INR',
  ): Promise<FinancialSummaryDto> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access merchant financial balances');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, merchantId);
    }

    const account = await this.repo.findAccountByMerchantAndCurrency(merchantId, currency, 'MERCHANT_BALANCE');
    const entries = await this.repo.listLedgerEntries(merchantId);

    let totalEarnings = 0;
    let totalCommissions = 0;
    let totalFees = 0;
    let totalRefunds = 0;
    let totalAdjustments = 0;

    for (const e of entries) {
      if (e.currency !== currency) continue;
      const amt = Number(e.amount);
      if (e.entry_type === 'EARNING') {
        totalEarnings = round2(totalEarnings + amt);
      } else if (e.entry_type === 'COMMISSION') {
        if (e.direction === 'DEBIT') {
          totalCommissions = round2(totalCommissions + amt);
        } else {
          totalCommissions = round2(totalCommissions - amt);
        }
      } else if (e.entry_type === 'FEE') {
        totalFees = round2(totalFees + amt);
      } else if (e.entry_type === 'REFUND') {
        totalRefunds = round2(totalRefunds + amt);
      } else if (e.entry_type === 'ADJUSTMENT') {
        if (e.direction === 'CREDIT') {
          totalAdjustments = round2(totalAdjustments + amt);
        } else {
          totalAdjustments = round2(totalAdjustments - amt);
        }
      }
    }

    return {
      tenantId: merchantId,
      currency,
      currentBalance: account ? Number(account.current_balance) : 0,
      pendingBalance: account ? Number(account.pending_balance) : 0,
      settledBalance: account ? Number(account.settled_balance) : 0,
      totalEarnings,
      totalCommissions,
      totalFees,
      totalRefunds,
      totalAdjustments,
      ledgerCount: entries.length,
    };
  }

  async listLedgerEntries(
    actor: AuthorizedActor,
    merchantId: string,
    filter: ListLedgerEntriesFilter = {},
  ): Promise<LedgerEntryDto[]> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access merchant ledger entries');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, merchantId);
    }

    const rows = await this.repo.listLedgerEntries(merchantId, filter);
    return rows.map((r) => this.toLedgerEntryDto(r));
  }

  async getSettlement(actor: AuthorizedActor, settlementId: string): Promise<SettlementDto> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access settlements');
    }

    const row = await this.repo.findSettlementById(settlementId);
    if (!row) {
      throw new NotFoundError(`Settlement '${settlementId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, row.tenant_id);
    }

    const items = await this.repo.findSettlementItems(settlementId);
    return this.toSettlementDto(row, items);
  }

  // DTO Mappers
  private toLedgerEntryDto(row: LedgerEntryRow): LedgerEntryDto {
    return {
      id: row.id,
      financialTransactionId: row.financial_transaction_id ?? null,
      tenantId: row.tenant_id,
      accountId: row.account_id,
      entryType: row.entry_type,
      direction: row.direction,
      amount: Number(row.amount),
      currency: row.currency,
      sourceType: row.source_type,
      sourceId: row.source_id,
      description: row.description,
      reason: row.reason,
      actorId: row.actor_id,
      actorType: row.actor_type,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata ?? {},
      createdAt: row.created_at.toISOString(),
    };
  }

  private toAdjustmentDto(row: FinancialAdjustmentRow): FinancialAdjustmentDto {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      amount: Number(row.amount),
      currency: row.currency,
      type: row.type,
      reason: row.reason,
      status: row.status,
      actorId: row.actor_id,
      actorType: row.actor_type,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at.toISOString(),
    };
  }

  private toSettlementDto(
    row: SettlementRow,
    items: Array<{ id: string; settlement_id: string; ledger_entry_id: string; created_at: Date }> = [],
  ): SettlementDto {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      periodStart: row.period_start.toISOString(),
      periodEnd: row.period_end.toISOString(),
      currency: row.currency,
      grossAmount: Number(row.gross_amount),
      commissionAmount: Number(row.commission_amount),
      feeAmount: Number(row.fee_amount),
      refundAmount: Number(row.refund_amount),
      adjustmentAmount: Number(row.adjustment_amount),
      netPayableAmount: Number(row.net_payable_amount),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      snapshotData: row.snapshot_data ?? {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      items: items.map((i) => ({
        id: i.id,
        settlementId: i.settlement_id,
        ledgerEntryId: i.ledger_entry_id,
        createdAt: i.created_at.toISOString(),
      })),
    };
  }
}
