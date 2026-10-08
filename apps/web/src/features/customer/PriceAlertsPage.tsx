import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Link, Navigate } from 'react-router-dom';
import { Bell, BellOff, ExternalLink } from 'lucide-react';
import { priceAlertsApi, PriceAlertDto } from './api/price-alerts';

export const PriceAlertsPage = () => {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<PriceAlertDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    loadAlerts();
  }, [user]);

  const loadAlerts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await priceAlertsApi.getMyAlerts();
      setAlerts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load price alerts');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnsubscribe = async (productId: string) => {
    try {
      await priceAlertsApi.unsubscribe(productId);
      setAlerts(alerts.filter(a => a.productId !== productId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unsubscribe');
    }
  };

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Bell size={28} style={{ color: 'var(--brand)' }} />
        <div>
          <h1 className="font-display" style={{ fontSize: '1.75rem', margin: 0 }}>Price Alerts</h1>
          <p className="text-muted" style={{ margin: 0 }}>Products you are watching for price drops</p>
        </div>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading your price alerts...</div>}
      
      {error && (
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>
          ⚠️ {error}
        </div>
      )}

      {!isLoading && !error && alerts.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          <BellOff size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', color: 'var(--text-main)' }}>No active price alerts</h2>
          <p style={{ margin: 0 }}>When you view products, we automatically track your interest to notify you if the price drops.</p>
          <Link to="/" className="btn btn-primary" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
            Browse Catalog
          </Link>
        </div>
      )}

      {!isLoading && !error && alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {alerts.map(alert => (
            <div key={alert.id} className="card" style={{ padding: '1.5rem', display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {alert.productThumbnailUrl ? (
                <img 
                  src={alert.productThumbnailUrl} 
                  alt={alert.productTitle} 
                  style={{ width: '80px', height: '80px', objectFit: 'contain', borderRadius: '8px', background: 'var(--bg-main)' }} 
                />
              ) : (
                <div style={{ width: '80px', height: '80px', background: 'var(--bg-main)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-muted)' }}>
                  No Image
                </div>
              )}
              
              <div style={{ flex: 1, minWidth: '200px' }}>
                <h3 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem' }}>{alert.productTitle}</h3>
                {alert.productBrand && <p className="text-muted" style={{ margin: '0 0 0.5rem', fontSize: '0.9rem' }}>{alert.productBrand}</p>}
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>Status: Watching</span>
                  <span className="text-muted">Since {new Date(alert.createdAt).toLocaleDateString()}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginLeft: 'auto' }}>
                <Link to={`/products/${alert.productId}`} className="btn btn-secondary" style={{ padding: '0.5rem 1rem' }}>
                  <ExternalLink size={16} style={{ marginRight: '0.25rem' }} /> View
                </Link>
                <button 
                  onClick={() => handleUnsubscribe(alert.productId)}
                  className="btn" 
                  style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent-red)' }}
                >
                  Unsubscribe
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
