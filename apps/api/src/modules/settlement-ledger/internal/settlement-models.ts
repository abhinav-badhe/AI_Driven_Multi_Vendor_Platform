import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  FinancialAccountDto,
  LedgerEntryDto,
  FinancialAdjustmentDto,
  SettlementDto,
  SettlementItemDto,
  FinancialSummaryDto,
  LedgerEntryType,
  LedgerDirection,
  SettlementStatus,
  FinancialAdjustmentType,
  FinancialAdjustmentStatus,
  IngestOrderFinancialsInput,
  IngestRefundFinancialsInput,
  CreateAdjustmentInput,
  CalculateSettlementInput,
  TransitionSettlementInput,
  ListLedgerEntriesFilter,
} from './types.js';

export type {
  FinancialAccountDto,
  LedgerEntryDto,
  FinancialAdjustmentDto,
  SettlementDto,
  SettlementItemDto,
  FinancialSummaryDto,
  LedgerEntryType,
  LedgerDirection,
  SettlementStatus,
  FinancialAdjustmentType,
  FinancialAdjustmentStatus,
  IngestOrderFinancialsInput,
  IngestRefundFinancialsInput,
  CreateAdjustmentInput,
  CalculateSettlementInput,
  TransitionSettlementInput,
  ListLedgerEntriesFilter,
};

export interface IngestOrderFinancialsResultDto {
  earningEntry: LedgerEntryDto;
  commissionEntry: LedgerEntryDto;
  feeEntry?: LedgerEntryDto | undefined;
}

export interface IngestRefundFinancialsResultDto {
  refundEntry: LedgerEntryDto;
  commissionReversalEntry?: LedgerEntryDto | undefined;
}

export interface CreateAdjustmentResultDto {
  adjustment: FinancialAdjustmentDto;
  ledgerEntry: LedgerEntryDto;
}

/**
 * ISettlementReader - Decoupled read interface for downstream consumers.
 */
export interface ISettlementReader {
  getFinancialSummary(
    actor: AuthorizedActor,
    merchantId: string,
    currency?: string,
  ): Promise<FinancialSummaryDto>;

  listLedgerEntries(
    actor: AuthorizedActor,
    merchantId: string,
    filter?: ListLedgerEntriesFilter,
  ): Promise<LedgerEntryDto[]>;

  getSettlement(actor: AuthorizedActor, settlementId: string): Promise<SettlementDto>;
}

/**
 * ISettlementService - Full settlement and double-entry ledger interface.
 * Implemented by SettlementService (SQL), InMemorySettlementStore, and HttpSettlementClient.
 */
export interface ISettlementService extends ISettlementReader {
  ingestOrderFinancials(
    actor: AuthorizedActor,
    input: IngestOrderFinancialsInput,
  ): Promise<IngestOrderFinancialsResultDto>;

  ingestRefundFinancials(
    actor: AuthorizedActor,
    input: IngestRefundFinancialsInput,
  ): Promise<IngestRefundFinancialsResultDto>;

  createAdjustment(
    actor: AuthorizedActor,
    input: CreateAdjustmentInput,
  ): Promise<CreateAdjustmentResultDto>;

  calculateSettlement(
    actor: AuthorizedActor,
    input: CalculateSettlementInput,
  ): Promise<SettlementDto>;

  transitionSettlementStatus(
    actor: AuthorizedActor,
    settlementId: string,
    input: TransitionSettlementInput,
  ): Promise<SettlementDto>;
}
