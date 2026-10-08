import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Navigate } from 'react-router-dom';
import { merchantReviewsApi, ModerationReviewDto } from '../catalog/api/reviews-moderation';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Star } from 'lucide-react';

export const MerchantReviews = () => {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<ModerationReviewDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');

  useEffect(() => {
    if (user?.role !== 'MERCHANT') return;
    loadReviews();
  }, [user, statusFilter]);

  const loadReviews = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantReviewsApi.listReviews({ status: statusFilter !== 'ALL' ? statusFilter : undefined });
      setReviews(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load reviews');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (id: string, action: 'APPROVE' | 'REJECT', currentNote: string | null) => {
    const note = window.prompt(`Enter moderation note for ${action.toLowerCase()} (optional):`, currentNote || '') ?? undefined;
    if (note === undefined && action === 'REJECT') return; // Cancelled

    try {
      if (action === 'APPROVE') {
        await merchantReviewsApi.approve(id, note);
      } else {
        await merchantReviewsApi.reject(id, note);
      }
      loadReviews();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to apply moderation action');
    }
  };

  if (user?.role !== 'MERCHANT') return <Navigate to="/account" replace />;

  return (
    <div style={{ padding: '2rem 0 4rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="font-display" style={{ fontSize: '1.75rem' }}>Customer Reviews</h1>
        <p className="text-muted">Manage and moderate reviews for your products.</p>
      </div>

      <div className="card" style={{ padding: '1rem', marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '0.5rem 0.85rem', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-main)', color: 'var(--text-main)',
          }}
        >
          <option value="ALL">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>

      {isLoading && <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading reviews...</div>}
      {error && <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent-red)' }}>⚠️ {error}</div>}
      
      {!isLoading && !error && reviews.length === 0 && (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--primary-muted)' }}>
          No {statusFilter !== 'ALL' ? statusFilter.toLowerCase() : ''} reviews found for your products.
        </div>
      )}

      {!isLoading && !error && reviews.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {reviews.map((r) => (
            <Card key={r.id}>
              <CardContent style={{ padding: '1.5rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '250px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', color: 'var(--accent-amber)' }}>
                      {[...Array(5)].map((_, i) => (
                        <Star key={i} size={16} fill={i < r.rating ? 'currentColor' : 'none'} />
                      ))}
                    </div>
                    <span style={{
                      padding: '0.15rem 0.5rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
                      background: r.status === 'APPROVED' ? 'rgba(34,197,94,0.1)' : r.status === 'REJECTED' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                      color: r.status === 'APPROVED' ? 'var(--accent-green)' : r.status === 'REJECTED' ? 'var(--accent-red)' : 'var(--accent-amber)'
                    }}>
                      {r.status}
                    </span>
                  </div>
                  <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>{r.headline || 'No Headline'}</h3>
                  <p style={{ margin: '0 0 1rem', color: 'var(--text-main)', fontSize: '0.95rem' }}>{r.content || 'No content provided.'}</p>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1rem', fontSize: '0.8rem', color: 'var(--primary-muted)' }}>
                    <span>Product ID:</span> <span style={{ fontFamily: 'monospace' }}>{r.productId}</span>
                    <span>Created:</span> <span>{new Date(r.createdAt).toLocaleString()}</span>
                    {r.moderationNote && (
                      <>
                        <span>Moderation Note:</span> <span style={{ color: 'var(--brand)', fontWeight: 500 }}>{r.moderationNote}</span>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: '120px', alignSelf: 'flex-start' }}>
                  <Button 
                    variant={r.status === 'APPROVED' ? 'outline' : 'default'} 
                    onClick={() => handleAction(r.id, 'APPROVE', r.moderationNote)}
                  >
                    Approve
                  </Button>
                  <Button 
                    variant="destructive" 
                    onClick={() => handleAction(r.id, 'REJECT', r.moderationNote)}
                  >
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
