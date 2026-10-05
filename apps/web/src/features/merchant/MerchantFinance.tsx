import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';

export interface MerchantFinancialSummaryDto {
  merchantId: string;
  currency: string;
  pendingSettlementMinor: number;
  settledBalanceMinor: number;
  reserveBalanceMinor: number;
  totalEarningsMinor: number;
  totalCommissionsMinor: number;
  totalFeesMinor: number;
  totalRefundsMinor: number;
  updatedAt: string;
}

export interface LedgerEntryDto {
  id: string;
  merchantId: string;
  entryType: 'EARNING' | 'COMMISSION' | 'FEE' | 'REFUND' | 'ADJUSTMENT' | 'PAYOUT';
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  description?: string;
  createdAt: string;
}

export const MerchantFinance = () => {
  const { user } = useAuth();
  const [summary, setSummary] = useState<MerchantFinancialSummaryDto | null>(null);
  const [entries, setEntries] = useState<LedgerEntryDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const formatPrice = (minor: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0,
    }).format(minor / 100);
  };

  const loadFinance = async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const merchantId = user.tenantId;
      const [sumData, ledgerData] = await Promise.all([
        apiClient<MerchantFinancialSummaryDto>(`/settlement/merchants/${merchantId}/summary`).catch(() => null),
        apiClient<{ entries: LedgerEntryDto[] }>(`/settlement/merchants/${merchantId}/ledger`).catch(() => ({ entries: [] })),
      ]);
      setSummary(sumData);
      setEntries(ledgerData.entries || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load merchant finance');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFinance();
  }, [user]);

  if (isLoading) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
        <p className="text-muted">Loading double-entry financial settlement records...</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
          Finance &amp; Settlement Ledger
        </h1>
        <p className="text-muted" style={{ fontSize: '0.9rem' }}>
          Immutable double-entry ledger records, earnings attribution, platform commissions, and payout balances.
        </p>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '1rem' }}>
          {error}
        </div>
      )}

      {/* Financial KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem' }}>
        <div className="card" style={{ padding: '1.25rem' }}>
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>Available Settled Balance</span>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-green)', marginTop: '0.4rem' }}>
            {formatPrice(summary?.settledBalanceMinor ?? 0, summary?.currency)}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Eligible for immediate payout</span>
        </div>

        <div className="card" style={{ padding: '1.25rem' }}>
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>Pending Settlement Hold</span>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-amber)', marginTop: '0.4rem' }}>
            {formatPrice(summary?.pendingSettlementMinor ?? 0, summary?.currency)}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Orders awaiting fulfillment delivery</span>
        </div>

        <div className="card" style={{ padding: '1.25rem' }}>
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>Total Gross Earnings</span>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--brand)', marginTop: '0.4rem' }}>
            {formatPrice(summary?.totalEarningsMinor ?? 0, summary?.currency)}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Cumulative gross merchandise value</span>
        </div>

        <div className="card" style={{ padding: '1.25rem' }}>
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>Platform Commissions Paid</span>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--text-main)', marginTop: '0.4rem' }}>
            {formatPrice(summary?.totalCommissionsMinor ?? 0, summary?.currency)}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>Platform commission fees</span>
        </div>
      </div>

      {/* Ledger Audit Table */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>Double-Entry Ledger Audit Log</h2>
            <p className="text-muted" style={{ fontSize: '0.8rem' }}>
              Enforces balanced debits and credits on every journal transaction (Section 17).
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={loadFinance}>
            Refresh
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
            No financial ledger entries recorded yet. As orders are placed and confirmed, journals will append here.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--primary-muted)' }}>
                  <th style={{ padding: '0.75rem' }}>Date &amp; Time</th>
                  <th style={{ padding: '0.75rem' }}>Entry Type</th>
                  <th style={{ padding: '0.75rem' }}>Direction</th>
                  <th style={{ padding: '0.75rem' }}>Amount</th>
                  <th style={{ padding: '0.75rem' }}>Source Aggregate</th>
                  <th style={{ padding: '0.75rem' }}>Description</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.75rem', whiteSpace: 'nowrap', color: 'var(--primary-muted)' }}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.75rem', fontWeight: 600 }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          background:
                            entry.entryType === 'EARNING'
                              ? 'rgba(34, 197, 94, 0.15)'
                              : entry.entryType === 'REFUND'
                              ? 'rgba(239, 68, 68, 0.15)'
                              : 'rgba(37, 99, 235, 0.15)',
                          color:
                            entry.entryType === 'EARNING'
                              ? 'var(--accent-green)'
                              : entry.entryType === 'REFUND'
                              ? 'var(--accent-red)'
                              : 'var(--brand)',
                        }}
                      >
                        {entry.entryType}
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem', fontWeight: 700 }}>
                      {entry.direction === 'CREDIT' ? (
                        <span style={{ color: 'var(--accent-green)' }}>+ CREDIT</span>
                      ) : (
                        <span style={{ color: 'var(--accent-red)' }}>&minus; DEBIT</span>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem', fontWeight: 700 }}>
                      {formatPrice(entry.amountMinor, entry.currency)}
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <code style={{ fontSize: '0.8rem' }}>{entry.sourceType}: {entry.sourceId.slice(0, 10)}...</code>
                    </td>
                    <td style={{ padding: '0.75rem', color: 'var(--primary-muted)' }}>
                      {entry.description || 'System journal settlement entry'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
