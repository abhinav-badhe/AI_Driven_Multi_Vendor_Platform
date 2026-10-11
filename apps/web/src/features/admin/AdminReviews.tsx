import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Navigate } from 'react-router-dom';
import { adminReviewsApi, ModerationReviewDto } from '../catalog/api/reviews-moderation';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { Star, CheckCircle2 } from 'lucide-react';

export const AdminReviews = () => {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<ModerationReviewDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('PENDING');

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadReviews();
  }, [user, statusFilter]);

  const loadReviews = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await adminReviewsApi.listReviews(
        statusFilter !== 'ALL' ? { status: statusFilter } : {},
      );
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
        await adminReviewsApi.approve(id, note);
      } else {
        await adminReviewsApi.reject(id, note);
      }
      loadReviews();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to apply moderation action');
    }
  };

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  return (
    <div className="space-y-4 py-4 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Review Moderation</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Manage and moderate reviews submitted across the platform.</p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-review-filter" className="text-xs font-medium text-muted-foreground">
            Status:
          </label>
          <select
            id="admin-review-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
          >
            <option value="ALL">All Statuses</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="p-8 text-center text-xs text-muted-foreground">
            Loading reviews…
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert tone="error">{error}</Alert>
      )}

      {!isLoading && !error && reviews.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-xs text-muted-foreground">
            No {statusFilter !== 'ALL' ? statusFilter.toLowerCase() : ''} reviews found.
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && reviews.length > 0 && (
        <div className="flex flex-col gap-3">
          {reviews.map((r) => {
            const headline = r.title || r.headline || 'No Headline';
            const content = r.comment || r.content || 'No content provided.';
            return (
              <Card key={r.id}>
                <CardContent className="p-4 flex flex-col sm:flex-row gap-4 justify-between items-start">
                  <div className="flex-1 space-y-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-0.5 text-amber-500">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={`size-3.5 ${i < r.rating ? 'fill-amber-500 text-amber-500' : 'text-muted-foreground/30'}`}
                          />
                        ))}
                      </div>

                      <Badge
                        variant={
                          r.status === 'APPROVED'
                            ? 'success'
                            : r.status === 'REJECTED'
                            ? 'destructive'
                            : 'warning'
                        }
                      >
                        {r.status}
                      </Badge>

                      {r.verifiedPurchase && (
                        <Badge variant="outline" className="text-[11px] gap-1">
                          <CheckCircle2 className="size-3 text-success" />
                          Verified Purchase
                        </Badge>
                      )}

                      {r.reviewerName && (
                        <span className="text-xs text-muted-foreground">
                          by <strong className="font-medium text-foreground">{r.reviewerName}</strong>
                        </span>
                      )}
                    </div>

                    <h3 className="text-sm font-semibold text-foreground tracking-tight">
                      {headline}
                    </h3>
                    <p className="text-xs sm:text-[13px] text-foreground/90 leading-relaxed whitespace-pre-line">
                      {content}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground pt-2 border-t border-border/60">
                      <div>
                        <span className="font-medium text-foreground">Product ID: </span>
                        <span className="font-mono text-[11px]">{r.productId}</span>
                      </div>
                      {r.customerId && (
                        <div>
                          <span className="font-medium text-foreground">Customer ID: </span>
                          <span className="font-mono text-[11px]">{r.customerId}</span>
                        </div>
                      )}
                      <div>
                        <span className="font-medium text-foreground">Submitted: </span>
                        <span>{new Date(r.createdAt).toLocaleString()}</span>
                      </div>
                      {r.moderationNote && (
                        <div className="sm:col-span-2 pt-0.5">
                          <span className="font-medium text-foreground">Admin Note: </span>
                          <span className="italic text-foreground/80">{r.moderationNote}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-row sm:flex-col gap-2 shrink-0 self-start w-full sm:w-28 pt-1 sm:pt-0">
                    <Button
                      size="sm"
                      variant={r.status === 'APPROVED' ? 'outline' : 'default'}
                      onClick={() => handleAction(r.id, 'APPROVE', r.moderationNote)}
                      className="flex-1 sm:w-full"
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleAction(r.id, 'REJECT', r.moderationNote)}
                      className="flex-1 sm:w-full"
                    >
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
