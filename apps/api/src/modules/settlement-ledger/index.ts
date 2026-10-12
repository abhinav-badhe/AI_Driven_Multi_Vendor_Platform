/**
 * BOUNDED CONTEXT: Settlement/Ledger
 * Ownership: Seller financial balances, earnings, commissions/fees, refunds/adjustments,
 * settlements, ledger entries, and audit trail.
 */
import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OrderService, IOrderReader } from '../orders/index.js';
import type { PaymentService, IPaymentService } from '../payment/index.js';
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

import type {
  ISettlementReader,
  ISettlementService,
  IngestOrderFinancialsResultDto,
  IngestRefundFinancialsResultDto,
} from './internal/settlement-models.js';
import { InMemorySettlementStore } from './internal/in-memory-settlement-store.js';
import {
  HttpSettlementClient,
  type HttpSettlementClientOptions,
} from './internal/http-settlement-client.js';

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
  ISettlementReader,
  ISettlementService,
  IngestOrderFinancialsResultDto,
  IngestRefundFinancialsResultDto,
  HttpSettlementClientOptions,
};

export { SettlementService, InMemorySettlementStore, HttpSettlementClient };

export interface SettlementLedgerModule {
  readonly contextName: 'settlement-ledger';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: IOrderReader | OrderService,
    paymentService: IPaymentService | PaymentService,
  ): SettlementService;
  createHttpClient(serviceUrl: string, options?: HttpSettlementClientOptions): HttpSettlementClient;
  createInMemoryStore(): InMemorySettlementStore;
}

export const settlementLedgerModule: SettlementLedgerModule = {
  contextName: 'settlement-ledger',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: IOrderReader | OrderService,
    paymentService: IPaymentService | PaymentService,
  ): SettlementService {
    return new SettlementService(db, logger, orderService, paymentService);
  },
  createHttpClient(
    serviceUrl: string,
    options?: HttpSettlementClientOptions,
  ): HttpSettlementClient {
    return new HttpSettlementClient(serviceUrl, options);
  },
  createInMemoryStore(): InMemorySettlementStore {
    return new InMemorySettlementStore();
  },
};
