import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface Order {
  id: string;
  customerId?: string;
  status: string;
  paymentStatus?: string;
  totalAmount: number;
  createdAt: string;
}

export const AdminOrders = () => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/admin/orders')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as Order[])
          : ((res as { orders?: Order[] }).orders ?? []);
        setOrders(list);
      })
      .catch(() =>
        apiClient<unknown>('/orders?limit=50')
          .then((res2) => {
            const list = Array.isArray(res2)
              ? (res2 as Order[])
              : ((res2 as { orders?: Order[] }).orders ?? []);
            setOrders(list);
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load orders')),
      )
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = orders.filter((o) => statusFilter === 'ALL' || o.status === statusFilter);

  const statusColor = (s: string) => {
    if (s === 'DELIVERED') return 'var(--accent-green)';
    if (s === 'CANCELLED') return 'var(--accent-red)';
    if (s === 'PENDING') return 'var(--accent-amber)';
    return 'var(--primary-muted)';
  };

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Platform Orders</h1>
          <p className="text-muted">All customer orders ({orders.length} total)</p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '0.5rem 0.85rem', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)',
          }}
        >
          {['ALL', 'PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading orders...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>No orders found</div>
      )}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['Order ID', 'Customer', 'Total', 'Status', 'Payment', 'Date'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, i) => (
                <tr key={o.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem' }}>{o.id.slice(0, 8)}...</td>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)' }}>
                    {o.customerId?.slice(0, 8) ?? '—'}
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontWeight: 700 }}>₹{((o.totalAmount ?? 0) / 100).toFixed(2)}</td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{ color: statusColor(o.status), fontWeight: 700, fontSize: '0.8rem' }}>{o.status}</span>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)', fontSize: '0.8rem' }}>{o.paymentStatus ?? '—'}</td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>
                    {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}
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
