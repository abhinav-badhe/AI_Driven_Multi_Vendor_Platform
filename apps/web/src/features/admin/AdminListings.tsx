import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface Listing {
  id: string;
  productTitle?: string;
  skuCode?: string;
  sellerPrice: number;
  status: string;
  merchantId?: string;
  tenantId?: string;
  createdAt: string;
}

export const AdminListings = () => {
  const { user } = useAuth();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/admin/listings')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as Listing[])
          : ((res as { listings?: Listing[] }).listings ?? []);
        setListings(list);
      })
      .catch(() =>
        apiClient<unknown>('/listings?limit=50')
          .then((res2) => {
            const list = Array.isArray(res2)
              ? (res2 as Listing[])
              : ((res2 as { listings?: Listing[] }).listings ?? []);
            setListings(list);
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load listings')),
      )
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const statusColor = (s: string) =>
    s === 'ACTIVE' ? 'var(--accent-green)' : s === 'INACTIVE' ? 'var(--accent-red)' : 'var(--accent-amber)';

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>
          Merchant Listings
        </h1>
        <p className="text-muted">All seller listings across all merchants ({listings.length} total)</p>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading listings...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}
      {!isLoading && !error && listings.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>No listings yet</div>
      )}
      {!isLoading && !error && listings.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['Listing ID', 'Product / SKU', 'Price', 'Status', 'Merchant', 'Created'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listings.map((l, i) => (
                <tr key={l.id} style={{ borderBottom: i < listings.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--primary-muted)' }}>
                    {l.id}
                  </td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <div style={{ fontWeight: 600 }}>{l.productTitle ?? '—'}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--primary-muted)' }}>{l.skuCode}</div>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontWeight: 700 }}>
                    ₹{((l.sellerPrice ?? 0) / 100).toFixed(2)}
                  </td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{ color: statusColor(l.status), fontWeight: 700, fontSize: '0.8rem' }}>{l.status}</span>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--primary-muted)' }}>
                    {l.merchantId ?? l.tenantId ?? '—'}
                  </td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>
                    {l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '—'}
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
