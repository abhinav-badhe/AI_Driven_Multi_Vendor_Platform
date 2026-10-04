import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface Payment {
  id: string;
  orderId?: string;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  createdAt: string;
}

export const AdminPayments = () => {
  const { user } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/admin/payments')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as Payment[])
          : ((res as { payments?: Payment[] }).payments ?? []);
        setPayments(list);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load payments'))
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const totalVolume = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Payment Management</h1>
        <p className="text-muted">
          Platform payment transactions. Total volume: <strong>₹{(totalVolume / 100).toFixed(2)}</strong>
        </p>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>⏳ Loading payments...</div>}
      {error && (
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--accent-red)', fontWeight: 600 }}>⚠️ {error}</p>
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>The /admin/payments endpoint may need to be implemented.</p>
        </div>
      )}
      {!isLoading && !error && payments.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          💳 No payment transactions found
        </div>
      )}
      {!isLoading && !error && payments.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['Payment ID', 'Order', 'Amount', 'Status', 'Method', 'Date'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payments.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: i < payments.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem' }}>{p.id.slice(0, 8)}...</td>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)' }}>
                    {p.orderId?.slice(0, 8) ?? '—'}
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontWeight: 700 }}>₹{((p.amount ?? 0) / 100).toFixed(2)}</td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{
                      color: p.status === 'CAPTURED' ? 'var(--accent-green)' : p.status === 'FAILED' ? 'var(--accent-red)' : 'var(--accent-amber)',
                      fontWeight: 700, fontSize: '0.8rem',
                    }}>
                      {p.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>{p.method ?? '—'}</td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>
                    {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
