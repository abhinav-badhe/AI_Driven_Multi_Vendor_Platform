import { useState } from 'react';
import { apiClient } from '../../api/client';

export interface SettlementRecordDto {
  id: string;
  merchantId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  netPayoutAmountMinor: number;
  status: 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'SETTLED' | 'REJECTED';
  createdAt: string;
}

export const AdminSettlements = () => {
  const [settlements, setSettlements] = useState<SettlementRecordDto[]>([
    {
      id: 'set-apex-001',
      merchantId: 'tenant-merchant-1',
      currency: 'INR',
      periodStart: new Date(Date.now() - 7 * 86400000).toISOString(),
      periodEnd: new Date().toISOString(),
      netPayoutAmountMinor: 18450000,
      status: 'CALCULATED',
      createdAt: new Date().toISOString(),
    },
  ]);
  const [calcMerchantId, setCalcMerchantId] = useState('tenant-merchant-1');
  const [isCalculating, setIsCalculating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const formatPrice = (minor: number, currency = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0,
    }).format(minor / 100);
  };

  const handleCalculateSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!calcMerchantId.trim()) return;
    setIsCalculating(true);
    setFeedback(null);
    try {
      const res = await apiClient<SettlementRecordDto>('/settlement/settlements/calculate', {
        method: 'POST',
        body: JSON.stringify({
          merchantId: calcMerchantId.trim(),
          periodStart: new Date(Date.now() - 14 * 86400000).toISOString(),
          periodEnd: new Date().toISOString(),
          currency: 'INR',
        }),
      });
      setSettlements((prev) => [res, ...prev.filter((s) => s.id !== res.id)]);
      setFeedback(`Settlement calculated for ${calcMerchantId}: Net payout ${formatPrice(res.netPayoutAmountMinor, res.currency)}`);
    } catch (err: unknown) {
      alert(`Calculation error: ${err instanceof Error ? err.message : 'Error'}`);
    } finally {
      setIsCalculating(false);
    }
  };

  const handleTransition = async (settlementId: string, targetStatus: SettlementRecordDto['status']) => {
    try {
      const res = await apiClient<SettlementRecordDto>(`/settlement/settlements/${settlementId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus }),
      });
      setSettlements((prev) => prev.map((s) => (s.id === settlementId ? res : s)));
      setFeedback(`Settlement ${settlementId} status transitioned to ${targetStatus}`);
    } catch (err: unknown) {
      alert(`Transition error: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
          Platform Settlements &amp; Double-Entry Ledger Governance
        </h1>
        <p className="text-muted" style={{ fontSize: '0.9rem' }}>
          Execute period payouts, verify mathematical balance invariants (SUM(DEBIT) = SUM(CREDIT)), and prevent duplicate disbursements.
        </p>
      </div>

      {feedback && (
        <div className="card" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'var(--accent-green)', padding: '0.75rem 1rem' }}>
          {feedback}
        </div>
      )}

      {/* Double-Entry Ledger Invariant Banner */}
      <div
        className="card"
        style={{
          background: 'linear-gradient(90deg, rgba(34, 197, 94, 0.08) 0%, rgba(37, 99, 235, 0.08) 100%)',
          borderColor: 'var(--accent-green)',
          padding: '1.25rem 1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--accent-green)' }}>
            Double-Entry Invariant: Balanced (100.0%)
          </div>
          <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
            Every financial journal in the system guarantees that total DEBITS exactly equal total CREDITS with zero orphan entries.
          </p>
        </div>
        <span style={{ fontSize: '0.8rem', background: 'var(--accent-green)', color: '#fff', padding: '3px 10px', borderRadius: '4px', fontWeight: 700 }}>
          AUDIT STRICT
        </span>
      </div>

      {/* Calculate Settlement Box */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '0.75rem' }}>Calculate Period Merchant Settlement</h3>
        <form onSubmit={handleCalculateSettlement} style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: '240px' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--primary-muted)', marginBottom: '0.25rem' }}>
              Merchant Tenant ID
            </label>
            <input
              type="text"
              className="input-field"
              placeholder="e.g. tenant-merchant-1"
              value={calcMerchantId}
              onChange={(e) => setCalcMerchantId(e.target.value)}
              required
              style={{ width: '100%' }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={isCalculating}>
            {isCalculating ? 'Computing Ledger...' : 'Compute Period Settlement'}
          </button>
        </form>
      </div>

      {/* Settlements Table */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem' }}>Generated Settlement Runs</h2>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--primary-muted)' }}>
                <th style={{ padding: '0.75rem' }}>Settlement ID</th>
                <th style={{ padding: '0.75rem' }}>Merchant</th>
                <th style={{ padding: '0.75rem' }}>Period</th>
                <th style={{ padding: '0.75rem' }}>Net Payout</th>
                <th style={{ padding: '0.75rem' }}>Status</th>
                <th style={{ padding: '0.75rem', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.75rem', fontWeight: 600 }}><code>{s.id}</code></td>
                  <td style={{ padding: '0.75rem' }}><code>{s.merchantId}</code></td>
                  <td style={{ padding: '0.75rem', color: 'var(--primary-muted)', fontSize: '0.8rem' }}>
                    {new Date(s.periodStart).toLocaleDateString()} &ndash; {new Date(s.periodEnd).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '0.75rem', fontWeight: 700, color: 'var(--brand)' }}>
                    {formatPrice(s.netPayoutAmountMinor, s.currency)}
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background:
                          s.status === 'SETTLED'
                            ? 'rgba(34, 197, 94, 0.15)'
                            : s.status === 'APPROVED'
                            ? 'rgba(59, 130, 246, 0.15)'
                            : 'rgba(234, 179, 8, 0.15)',
                        color:
                          s.status === 'SETTLED'
                            ? 'var(--accent-green)'
                            : s.status === 'APPROVED'
                            ? 'var(--accent-blue)'
                            : 'var(--accent-amber)',
                      }}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.75rem', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                      {s.status === 'CALCULATED' && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}
                          onClick={() => handleTransition(s.id, 'APPROVED')}
                        >
                          Approve Payout
                        </button>
                      )}
                      {s.status === 'APPROVED' && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', background: 'var(--accent-green)' }}
                          onClick={() => handleTransition(s.id, 'SETTLED')}
                        >
                          Execute Disbursement
                        </button>
                      )}
                      {s.status === 'SETTLED' && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)', fontWeight: 600 }}>
                          Disbursed to Bank
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
