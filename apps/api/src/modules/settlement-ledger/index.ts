/**
 * BOUNDED CONTEXT: Settlement/Ledger
 * Ownership: Seller financial balances, earnings, commissions/fees, refunds/adjustments,
 * settlements, ledger entries, and audit trail.
 */
import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OrderService } from '../orders/index.js';
import type { PaymentService } from '../payment/index.js';
import { SettlementService } from './internal/settlement-service.js';
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
} from './internal/types.js';

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

export { SettlementService };

export interface SettlementLedgerModule {
  readonly contextName: 'settlement-ledger';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: OrderService,
    paymentService: PaymentService,
  ): SettlementService;
}

export const settlementLedgerModule: SettlementLedgerModule = {
  contextName: 'settlement-ledger',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: OrderService,
    paymentService: PaymentService,
  ): SettlementService {
    return new SettlementService(db, logger, orderService, paymentService);
  },
};
