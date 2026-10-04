import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Navigate } from 'react-router-dom';

interface Product {
  id: string;
  title: string;
  brand: string;
  status: string;
  categoryId: string;
  createdAt: string;
}

export const AdminCatalog = () => {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    apiClient<unknown>('/products?limit=50')
      .then((res) => {
        const list = Array.isArray(res)
          ? (res as Product[])
          : ((res as { products?: Product[]; data?: Product[] }).products ??
             (res as { products?: Product[]; data?: Product[] }).data ?? []);
        setProducts(list);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error loading catalog'))
      .finally(() => setIsLoading(false));
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = products.filter(
    (p) =>
      !search ||
      p.title?.toLowerCase().includes(search.toLowerCase()) ||
      p.brand?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>
          Catalog Management
        </h1>
        <p className="text-muted">Canonical products ({products.length} total)</p>
      </div>

      <div className="card" style={{ padding: '1rem', marginBottom: '1.5rem' }}>
        <input
          type="search"
          placeholder="Search products..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '0.5rem 0.85rem', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)',
          }}
        />
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>⏳ Loading catalog...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>📦 No products found</div>
      )}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-main)' }}>
                {['Product', 'Brand', 'Status', 'Created'].map((h) => (
                  <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--primary-muted)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <div style={{ fontWeight: 600 }}>{p.title}</div>
                    <div style={{ fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--primary-muted)' }}>{p.id}</div>
                  </td>
                  <td style={{ padding: '0.85rem 1rem', color: 'var(--primary-muted)' }}>{p.brand ?? '—'}</td>
                  <td style={{ padding: '0.85rem 1rem' }}>
                    <span style={{
                      background: p.status === 'ACTIVE' ? '#22c55e22' : '#94a3b822',
                      color: p.status === 'ACTIVE' ? 'var(--accent-green)' : 'var(--primary-muted)',
                      padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.78rem', fontWeight: 700,
                    }}>
                      {p.status ?? 'DRAFT'}
                    </span>
                  </td>
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
