import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  ISettlementService,
  FinancialSummaryDto,
  LedgerEntryDto,
  SettlementDto,
  SettlementItemDto,
  FinancialAdjustmentDto,
  IngestOrderFinancialsInput,
  IngestRefundFinancialsInput,
  CreateAdjustmentInput,
  CalculateSettlementInput,
  TransitionSettlementInput,
  ListLedgerEntriesFilter,
  IngestOrderFinancialsResultDto,
  IngestRefundFinancialsResultDto,
  CreateAdjustmentResultDto,
  SettlementStatus,
} from './settlement-models.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

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

/**
 * InMemorySettlementStore - Zero-DB in-memory settlement & double-entry store for unit tests, offline resilience, and HTTP fallback.
 */
export class InMemorySettlementStore implements ISettlementService {
  private readonly ledgerEntries = new Map<string, LedgerEntryDto>();
  private readonly settlements = new Map<string, SettlementDto>();
  private readonly settlementItems = new Map<string, SettlementItemDto[]>();
  private readonly adjustments = new Map<string, FinancialAdjustmentDto>();
  private readonly idempotencyLedger = new Map<string, string>(); // tenantId:key -> resultId

  async getFinancialSummary(
    actor: AuthorizedActor,
    merchantId: string,
    currency = 'INR',
  ): Promise<FinancialSummaryDto> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access financial summaries');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:read-own');
      RbacPolicy.requireTenantMatch(actor, merchantId);
    }

    const entries = Array.from(this.ledgerEntries.values()).filter(
      (e) => e.tenantId === merchantId && e.currency === currency,
    );

    let currentBalance = 0;
    const pendingBalance = 0;
    let settledBalance = 0;
    let totalEarnings = 0;
    let totalCommissions = 0;
    let totalFees = 0;
    let totalRefunds = 0;
    let totalAdjustments = 0;

    for (const e of entries) {
      if (e.entryType === 'EARNING') {
        totalEarnings = round2(totalEarnings + e.amount);
        currentBalance = round2(currentBalance + e.amount);
      } else if (e.entryType === 'COMMISSION') {
        totalCommissions = round2(totalCommissions + e.amount);
        currentBalance = round2(currentBalance - e.amount);
      } else if (e.entryType === 'FEE') {
        totalFees = round2(totalFees + e.amount);
        currentBalance = round2(currentBalance - e.amount);
      } else if (e.entryType === 'REFUND') {
        totalRefunds = round2(totalRefunds + e.amount);
        currentBalance = round2(currentBalance - e.amount);
      } else if (e.entryType === 'REFUND_REVERSAL') {
        totalCommissions = round2(totalCommissions - e.amount);
        currentBalance = round2(currentBalance + e.amount);
      } else if (e.entryType === 'ADJUSTMENT') {
        if (e.direction === 'CREDIT') {
          totalAdjustments = round2(totalAdjustments + e.amount);
          currentBalance = round2(currentBalance + e.amount);
        } else {
          totalAdjustments = round2(totalAdjustments - e.amount);
          currentBalance = round2(currentBalance - e.amount);
        }
      } else if (e.entryType === 'PAYOUT') {
        currentBalance = round2(currentBalance - e.amount);
        settledBalance = round2(settledBalance + e.amount);
      }
    }

    return {
      tenantId: merchantId,
      currency,
      currentBalance: Math.max(0, currentBalance),
      pendingBalance,
      settledBalance,
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
    filter?: ListLedgerEntriesFilter,
  ): Promise<LedgerEntryDto[]> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access ledger entries');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:read-own');
      RbacPolicy.requireTenantMatch(actor, merchantId);
    }

    let entries = Array.from(this.ledgerEntries.values()).filter((e) => e.tenantId === merchantId);

    if (filter?.entryType) {
      entries = entries.filter((e) => e.entryType === filter.entryType);
    }
    if (filter?.sourceType) {
      entries = entries.filter((e) => e.sourceType === filter.sourceType);
    }
    if (filter?.sourceId) {
      entries = entries.filter((e) => e.sourceId === filter.sourceId);
    }
    if (filter?.startDate) {
      const from = new Date(filter.startDate).getTime();
      entries = entries.filter((e) => new Date(e.createdAt).getTime() >= from);
    }
    if (filter?.endDate) {
      const to = new Date(filter.endDate).getTime();
      entries = entries.filter((e) => new Date(e.createdAt).getTime() <= to);
    }

    // Sort descending by creation date
    entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return entries.slice(offset, offset + limit);
  }

  async getSettlement(actor: AuthorizedActor, settlementId: string): Promise<SettlementDto> {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access settlements');
    }

    const settlement = this.settlements.get(settlementId);
    if (!settlement) {
      throw new NotFoundError(`Settlement '${settlementId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, settlement.tenantId);
    }

    const items = this.settlementItems.get(settlementId) ?? [];
    return {
      ...settlement,
      items,
    };
  }

  async ingestOrderFinancials(
    actor: AuthorizedActor,
    input: IngestOrderFinancialsInput,
  ): Promise<IngestOrderFinancialsResultDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    if (!input.sellerOrderId) {
      throw new ValidationError('sellerOrderId is required');
    }

    if (input.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyLedger.get(cacheKey);
      if (existingId) {
        const existingEarning = this.ledgerEntries.get(existingId);
        if (existingEarning) {
          const existingCommission = Array.from(this.ledgerEntries.values()).find(
            (e) => e.sourceId === input.sellerOrderId && e.entryType === 'COMMISSION',
          );
          const existingFee = Array.from(this.ledgerEntries.values()).find(
            (e) => e.sourceId === input.sellerOrderId && e.entryType === 'FEE',
          );
          return {
            earningEntry: existingEarning,
            commissionEntry: existingCommission!,
            feeEntry: existingFee,
          };
        }
      }
    }

    const merchantId = actor.tenantId;
    const grossAmount = 1000;
    const commissionRate = input.commissionRate ?? 0.1;
    const commissionAmount = round2(grossAmount * commissionRate);
    const feeAmount = round2(input.feeAmount ?? 0);
    const now = new Date().toISOString();

    const earningEntry: LedgerEntryDto = {
      id: randomUUID(),
      financialTransactionId: randomUUID(),
      tenantId: merchantId,
      accountId: randomUUID(),
      entryType: 'EARNING',
      direction: 'CREDIT',
      amount: grossAmount,
      currency: 'INR',
      sourceType: 'ORDER',
      sourceId: input.sellerOrderId,
      description: `Gross merchandise earning for seller order ${input.sellerOrderId}`,
      reason: null,
      actorId: actor.userId,
      actorType: actor.role,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: {},
      createdAt: now,
    };

    const commissionEntry: LedgerEntryDto = {
      id: randomUUID(),
      financialTransactionId: earningEntry.financialTransactionId,
      tenantId: merchantId,
      accountId: randomUUID(),
      entryType: 'COMMISSION',
      direction: 'DEBIT',
      amount: commissionAmount,
      currency: 'INR',
      sourceType: 'ORDER',
      sourceId: input.sellerOrderId,
      description: `Platform commission for seller order ${input.sellerOrderId}`,
      reason: null,
      actorId: actor.userId,
      actorType: actor.role,
      idempotencyKey: null,
      metadata: {},
      createdAt: now,
    };

    let feeEntry: LedgerEntryDto | undefined;
    if (feeAmount > 0) {
      feeEntry = {
        id: randomUUID(),
        financialTransactionId: earningEntry.financialTransactionId,
        tenantId: merchantId,
        accountId: randomUUID(),
        entryType: 'FEE',
        direction: 'DEBIT',
        amount: feeAmount,
        currency: 'INR',
        sourceType: 'ORDER',
        sourceId: input.sellerOrderId,
        description: `Fixed fee for seller order ${input.sellerOrderId}`,
        reason: null,
        actorId: actor.userId,
        actorType: actor.role,
        idempotencyKey: null,
        metadata: {},
        createdAt: now,
      };
      this.ledgerEntries.set(feeEntry.id, feeEntry);
    }

    this.ledgerEntries.set(earningEntry.id, earningEntry);
    this.ledgerEntries.set(commissionEntry.id, commissionEntry);

    if (input.idempotencyKey) {
      this.idempotencyLedger.set(`${actor.tenantId}:${input.idempotencyKey}`, earningEntry.id);
    }

    return { earningEntry, commissionEntry, feeEntry };
  }

  async ingestRefundFinancials(
    actor: AuthorizedActor,
    input: IngestRefundFinancialsInput,
  ): Promise<IngestRefundFinancialsResultDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    if (!input.merchantId || !input.refundId || !input.refundAmount || !input.currency) {
      throw new ValidationError('merchantId, refundId, refundAmount, and currency are required');
    }

    const now = new Date().toISOString();
    const refundEntry: LedgerEntryDto = {
      id: randomUUID(),
      financialTransactionId: randomUUID(),
      tenantId: input.merchantId,
      accountId: randomUUID(),
      entryType: 'REFUND',
      direction: 'DEBIT',
      amount: input.refundAmount,
      currency: input.currency,
      sourceType: 'REFUND',
      sourceId: input.refundId,
      description: `Refund deduction for refund ${input.refundId}`,
      reason: input.reason ?? null,
      actorId: actor.userId,
      actorType: actor.role,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: {},
      createdAt: now,
    };

    let commissionReversalEntry: LedgerEntryDto | undefined;
    if (input.commissionRefundAmount && input.commissionRefundAmount > 0) {
      commissionReversalEntry = {
        id: randomUUID(),
        financialTransactionId: refundEntry.financialTransactionId,
        tenantId: input.merchantId,
        accountId: randomUUID(),
        entryType: 'REFUND_REVERSAL',
        direction: 'CREDIT',
        amount: input.commissionRefundAmount,
        currency: input.currency,
        sourceType: 'REFUND',
        sourceId: input.refundId,
        description: `Commission reversal for refund ${input.refundId}`,
        reason: null,
        actorId: actor.userId,
        actorType: actor.role,
        idempotencyKey: null,
        metadata: {},
        createdAt: now,
      };
      this.ledgerEntries.set(commissionReversalEntry.id, commissionReversalEntry);
    }

    this.ledgerEntries.set(refundEntry.id, refundEntry);
    return { refundEntry, commissionReversalEntry };
  }

  async createAdjustment(
    actor: AuthorizedActor,
    input: CreateAdjustmentInput,
  ): Promise<CreateAdjustmentResultDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    if (!input.merchantId || !input.amount || !input.currency || !input.type || !input.reason) {
      throw new ValidationError('merchantId, amount, currency, type, and reason are required');
    }

    const adjustmentId = randomUUID();
    const now = new Date().toISOString();
    const adjustment: FinancialAdjustmentDto = {
      id: adjustmentId,
      tenantId: input.merchantId,
      amount: input.amount,
      currency: input.currency,
      type: input.type,
      reason: input.reason,
      status: 'APPROVED',
      actorId: actor.userId,
      actorType: actor.role,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    };

    const ledgerEntry: LedgerEntryDto = {
      id: randomUUID(),
      financialTransactionId: randomUUID(),
      tenantId: input.merchantId,
      accountId: randomUUID(),
      entryType: 'ADJUSTMENT',
      direction: input.type === 'CREDIT' ? 'CREDIT' : 'DEBIT',
      amount: input.amount,
      currency: input.currency,
      sourceType: 'ADJUSTMENT',
      sourceId: adjustmentId,
      description: `Manual adjustment: ${input.reason}`,
      reason: input.reason,
      actorId: actor.userId,
      actorType: actor.role,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: {},
      createdAt: now,
    };

    this.adjustments.set(adjustmentId, adjustment);
    this.ledgerEntries.set(ledgerEntry.id, ledgerEntry);
    return { adjustment, ledgerEntry };
  }

  async calculateSettlement(
    actor: AuthorizedActor,
    input: CalculateSettlementInput,
  ): Promise<SettlementDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    if (!input.merchantId || !input.periodStart || !input.periodEnd || !input.currency) {
      throw new ValidationError('merchantId, periodStart, periodEnd, and currency are required');
    }

    const settlementId = randomUUID();
    const now = new Date().toISOString();
    const settlement: SettlementDto = {
      id: settlementId,
      tenantId: input.merchantId,
      periodStart: new Date(input.periodStart).toISOString(),
      periodEnd: new Date(input.periodEnd).toISOString(),
      currency: input.currency,
      grossAmount: 1000,
      commissionAmount: 100,
      feeAmount: 0,
      refundAmount: 0,
      adjustmentAmount: 0,
      netPayableAmount: 900,
      status: 'CALCULATED',
      idempotencyKey: input.idempotencyKey ?? null,
      snapshotData: {},
      createdAt: now,
      updatedAt: now,
      items: [],
    };

    this.settlements.set(settlementId, settlement);
    this.settlementItems.set(settlementId, []);
    return settlement;
  }

  async transitionSettlementStatus(
    actor: AuthorizedActor,
    settlementId: string,
    input: TransitionSettlementInput,
  ): Promise<SettlementDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'settlement:manage-any');
    }

    const current = this.settlements.get(settlementId);
    if (!current) {
      throw new NotFoundError(`Settlement '${settlementId}' not found`);
    }

    const allowed = VALID_SETTLEMENT_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(input.targetStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid settlement status transition from '${current.status}' to '${input.targetStatus}'`,
      );
    }

    const updated: SettlementDto = {
      ...current,
      status: input.targetStatus,
      updatedAt: new Date().toISOString(),
    };

    this.settlements.set(settlementId, updated);
    return updated;
  }

  // Testing helpers
  seedLedgerEntry(entry: LedgerEntryDto): void {
    this.ledgerEntries.set(entry.id, entry);
    if (entry.idempotencyKey) {
      this.idempotencyLedger.set(`${entry.tenantId}:${entry.idempotencyKey}`, entry.id);
    }
  }

  seedSettlement(settlement: SettlementDto, items: SettlementItemDto[] = []): void {
    this.settlements.set(settlement.id, settlement);
    this.settlementItems.set(settlement.id, items);
  }

  seedAdjustment(adjustment: FinancialAdjustmentDto): void {
    this.adjustments.set(adjustment.id, adjustment);
  }

  clear(): void {
    this.ledgerEntries.clear();
    this.settlements.clear();
    this.settlementItems.clear();
    this.adjustments.clear();
    this.idempotencyLedger.clear();
  }
}
