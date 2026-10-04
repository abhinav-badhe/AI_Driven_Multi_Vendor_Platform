import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { merchantApi, type InventoryItemDto } from './api/merchant';

export const MerchantInventory = () => {
  const [items, setItems] = useState<InventoryItemDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [delta, setDelta] = useState<number>(10);
  const [error, setError] = useState<string | null>(null);

  const fetchInventory = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantApi.getMyInventory();
      setItems(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch inventory');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, []);

  const handleAdjust = async (id: string) => {
    setAdjustingId(id);
    try {
      await merchantApi.adjustInventory(id, delta, 'Merchant manual replenishment');
      await fetchInventory();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to adjust inventory');
    } finally {
      setAdjustingId(null);
    }
  };

  return (
    <div className="container" style={{ padding: '2rem 1rem 4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>
            Inventory Management
          </h1>
          <p className="text-muted">
            Track On-Hand, Reserved, and Available stock with concurrency protection.
          </p>
        </div>
        <Link to="/merchant" className="btn btn-secondary">
          &larr; Back to Dashboard
        </Link>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)', marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {isLoading ? (
        <p className="text-muted" style={{ textAlign: 'center', padding: '3rem' }}>Loading inventory records...</p>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <p className="text-muted">No inventory records initialized for your merchant account.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: '1rem', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--primary-muted)', fontSize: '0.85rem' }}>
                <th style={{ padding: '0.75rem' }}>Listing ID</th>
                <th style={{ padding: '0.75rem' }}>SKU ID</th>
                <th style={{ padding: '0.75rem' }}>On Hand</th>
                <th style={{ padding: '0.75rem' }}>Reserved</th>
                <th style={{ padding: '0.75rem' }}>Available</th>
                <th style={{ padding: '0.75rem' }}>Version</th>
                <th style={{ padding: '0.75rem', textAlign: 'right' }}>Replenish</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const available = it.onHandQuantity - it.reservedQuantity - it.nonSellableQuantity;
                return (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--border)', fontSize: '0.9rem' }}>
                    <td style={{ padding: '0.75rem' }}><code>{it.listingId.slice(0, 10)}</code></td>
                    <td style={{ padding: '0.75rem' }}><code>{it.skuId.slice(0, 10)}</code></td>
                    <td style={{ padding: '0.75rem', fontWeight: 600 }}>{it.onHandQuantity}</td>
                    <td style={{ padding: '0.75rem', color: 'var(--accent-amber)' }}>{it.reservedQuantity}</td>
                    <td style={{ padding: '0.75rem', color: 'var(--accent-green)', fontWeight: 700 }}>
                      {available} units
                    </td>
                    <td style={{ padding: '0.75rem', color: 'var(--primary-muted)' }}>v{it.version}</td>
                    <td style={{ padding: '0.75rem', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                        <input
                          type="number"
                          value={delta}
                          onChange={(e) => setDelta(parseInt(e.target.value, 10) || 0)}
                          style={{ width: '60px', padding: '0.3rem', borderRadius: '4px', border: '1px solid var(--border)' }}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem' }}
                          disabled={adjustingId === it.id}
                          onClick={() => handleAdjust(it.id)}
                        >
                          {adjustingId === it.id ? 'Saving...' : '+ Add'}
                        </button>
                      </div>
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
