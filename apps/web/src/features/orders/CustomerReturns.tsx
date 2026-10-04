import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';

export interface CustomerReturnDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED';
  items: Array<{ orderItemId: string; quantity: number }>;
  createdAt: string;
}

export const CustomerReturns = () => {
  const { isAuthenticated, login } = useAuth();
  const [returns, setReturns] = useState<CustomerReturnDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReturns = async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<CustomerReturnDto[]>('/fulfillment/returns');
      setReturns(data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load returns');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '500px', margin: '0 auto', textAlign: 'center' }}>
        <div className="card" style={{ padding: '2rem' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Customer Returns Portal</h2>
          <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
            Please sign in to inspect return requests, tracking status, and refund disbursements.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => login({ email: 'customer@example.com', password: 'password123' })}
          >
            Sign in as Demo Customer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem', maxWidth: '850px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>
            My Returns &amp; Refunds
          </h1>
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>
            Track return authorizations (RMA), logistics pickups, and bank refund credits.
          </p>
        </div>
        <Link to="/orders" className="btn btn-secondary">
          View All Orders
        </Link>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem', padding: '1rem' }}>
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-muted" style={{ padding: '3rem', textAlign: 'center' }}>Loading your return history...</p>
      ) : returns.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <h3 style={{ fontSize: '1.15rem', marginBottom: '0.5rem' }}>No returns in progress</h3>
          <p className="text-muted" style={{ maxWidth: '400px', margin: '0 auto 1.5rem' }}>
            You have not requested returns on any delivered items. If you need to return a purchased item, visit your order history.
          </p>
          <Link to="/orders" className="btn btn-primary">
            Go to My Orders
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {returns.map((ret) => (
            <div key={ret.id} className="card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: '1rem' }}>RMA ID: {ret.id}</span>
                  <div style={{ fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                    Customer Order: <code>{ret.customerOrderId}</code> &bull; Seller Order: <code>{ret.sellerOrderId}</code>
                  </div>
                </div>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: '999px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    background:
                      ret.status === 'COMPLETED'
                        ? 'rgba(34, 197, 94, 0.15)'
                        : ret.status === 'APPROVED'
                        ? 'rgba(59, 130, 246, 0.15)'
                        : ret.status === 'REJECTED'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : 'rgba(234, 179, 8, 0.15)',
                    color:
                      ret.status === 'COMPLETED'
                        ? 'var(--accent-green)'
                        : ret.status === 'APPROVED'
                        ? 'var(--accent-blue)'
                        : ret.status === 'REJECTED'
                        ? 'var(--accent-red)'
                        : 'var(--accent-amber)',
                  }}
                >
                  {ret.status}
                </span>
              </div>

              <div style={{ background: 'var(--bg-main)', padding: '0.75rem 1rem', borderRadius: '6px', fontSize: '0.85rem' }}>
                <strong>Return Reason:</strong> {ret.reason}
              </div>

              <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                Requested on: {new Date(ret.createdAt).toLocaleString()} &bull; Items count: {ret.items?.length || 1}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
