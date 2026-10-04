import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface InvItem {
  id: string;
  listingId: string;
  onHand: number;
  reserved: number;
  nonSellable: number;
  available: number;
}

export const AdminInventory = () => {
  const { user } = useAuth();
  const [items, setItems] = useState<InvItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/admin/inventory')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as InvItem[])
          : ((res as { items?: InvItem[] }).items ?? []);
        setItems(list);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load inventory'))
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Platform Inventory</h1>
        <p className="text-muted">All inventory items across all merchants ({items.length} total)</p>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>⏳ Loading inventory...</div>}
      {error && (
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--accent-red)', fontWeight: 600 }}>⚠️ {error}</p>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            The /admin/inventory endpoint may need to be implemented in the backend.
          </p>
        </div>
      )}
      {!isLoading && !error && items.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          📦 No inventory records found
        </div>
      )}
      {!isLoading && !error && items.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['Listing ID', 'On Hand', 'Reserved', 'Non-Sellable', 'Available', 'Stock State'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const avail = item.available ?? (item.onHand - item.reserved - item.nonSellable);
                const isLow = avail <= 5;
                return (
                  <tr key={item.id} style={{ borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)' }}>
                      {item.listingId}
                    </td>
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>{item.onHand ?? 0}</td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--accent-amber)' }}>{item.reserved ?? 0}</td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--accent-red)' }}>{item.nonSellable ?? 0}</td>
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 700, color: isLow ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {avail}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <span style={{
                        background: isLow ? '#ef444422' : '#22c55e22',
                        color: isLow ? 'var(--accent-red)' : 'var(--accent-green)',
                        padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.78rem', fontWeight: 700,
                      }}>
                        {isLow ? 'LOW STOCK' : 'IN STOCK'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
