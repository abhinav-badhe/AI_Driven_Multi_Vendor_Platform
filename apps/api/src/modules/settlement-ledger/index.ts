/**
 * BOUNDED CONTEXT: Settlement/Ledger
 * Ownership: Seller earnings, payout calculations, settlement cycles, immutable financial ledger.
 */
export interface SettlementLedgerModule {
  readonly contextName: 'settlement-ledger';
}

export const settlementLedgerModule: SettlementLedgerModule = {
  contextName: 'settlement-ledger',
};
