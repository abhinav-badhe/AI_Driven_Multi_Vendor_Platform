import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';

export interface ReturnItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ReturnRequestDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED';
  items: ReturnItemDto[];
  createdAt: string;
}

export const MerchantReturns = () => {
  const { user } = useAuth();
  const [returns, setReturns] = useState<ReturnRequestDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadReturns = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<ReturnRequestDto[]>('/fulfillment/returns');
      setReturns(data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load return requests');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [user]);

  const handleUpdateReturnStatus = async (
    returnId: string,
    status: ReturnRequestDto['status'],
    options?: { restock?: boolean; restockCondition?: 'SELLABLE' | 'DEFECTIVE' },
  ) => {
    try {
      await apiClient<ReturnRequestDto>(`/fulfillment/returns/${returnId}/status`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          options,
        }),
      });
      setActionMessage(`Return ${returnId} updated to ${status}`);
      await loadReturns();
    } catch (err: unknown) {
      alert(`Action failed: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
            Merchant Return Requests &amp; Restock
          </h1>
          <p className="text-muted" style={{ fontSize: '0.9rem' }}>
            Review customer return inquiries, approve RMA shipments, inspect condition, and trigger restocking.
          </p>
        </div>

        <button type="button" className="btn btn-secondary" onClick={loadReturns}>
          Refresh
        </button>
      </div>

      {actionMessage && (
        <div className="card" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'var(--accent-green)', padding: '0.75rem 1rem' }}>
          {actionMessage}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', padding: '1rem' }}>
          {error}
        </div>
      )}

      <div className="card" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem' }}>Return Queue</h2>

        {isLoading ? (
          <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>Loading returns...</p>
        ) : returns.length === 0 ? (
          <p className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
            No returns requested by customers for your store.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {returns.map((ret) => (
              <div
                key={ret.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '1.25rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '1rem',
                  background: 'var(--bg-main)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem' }}>RMA #{ret.id.slice(0, 8)}</span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background:
                          ret.status === 'COMPLETED'
                            ? 'rgba(34, 197, 94, 0.15)'
                            : ret.status === 'APPROVED'
                            ? 'rgba(37, 99, 235, 0.15)'
                            : ret.status === 'REJECTED'
                            ? 'rgba(239, 68, 68, 0.15)'
                            : 'rgba(234, 179, 8, 0.15)',
                        color:
                          ret.status === 'COMPLETED'
                            ? 'var(--accent-green)'
                            : ret.status === 'APPROVED'
                            ? 'var(--brand)'
                            : ret.status === 'REJECTED'
                            ? 'var(--accent-red)'
                            : 'var(--accent-amber)',
                      }}
                    >
                      {ret.status}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>
                    Reason: <em>&ldquo;{ret.reason}&rdquo;</em>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)', marginTop: '0.2rem' }}>
                    Order: <code>{ret.customerOrderId}</code> &bull; Items: {ret.items?.length || 1} &bull; Requested: {new Date(ret.createdAt).toLocaleDateString()}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {ret.status === 'REQUESTED' && (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                        onClick={() => handleUpdateReturnStatus(ret.id, 'APPROVED')}
                      >
                        Approve RMA &rarr;
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', color: 'var(--accent-red)' }}
                        onClick={() => handleUpdateReturnStatus(ret.id, 'REJECTED')}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {ret.status === 'APPROVED' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                      onClick={() => handleUpdateReturnStatus(ret.id, 'RECEIVED')}
                    >
                      Mark Item Received &rarr;
                    </button>
                  )}
                  {ret.status === 'RECEIVED' && (
                    <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', background: 'var(--accent-green)' }}
                        onClick={() => handleUpdateReturnStatus(ret.id, 'COMPLETED', { restock: true, restockCondition: 'SELLABLE' })}
                      >
                        Restock (Sellable) &amp; Refund
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem', color: 'var(--accent-red)' }}
                        onClick={() => handleUpdateReturnStatus(ret.id, 'COMPLETED', { restock: false, restockCondition: 'DEFECTIVE' })}
                      >
                        Write Off (Defective)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
