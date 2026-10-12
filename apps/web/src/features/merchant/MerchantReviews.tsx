import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Navigate } from 'react-router-dom';
import { merchantReviewsApi, ModerationReviewDto } from '../catalog/api/reviews-moderation';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input } from '../../components/ui/input';
import { Star, CheckCircle2, MessageSquare, Search } from 'lucide-react';

const STATUS_FILTERS = [
  { label: 'All', value: 'ALL' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
];

export const MerchantReviews = () => {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<ModerationReviewDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (user?.role !== 'MERCHANT') return;
    loadReviews();
  }, [user, statusFilter]);

  const loadReviews = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantReviewsApi.listReviews(
        statusFilter !== 'ALL' ? { status: statusFilter } : {},
      );
      setReviews(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load reviews');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (
    id: string,
    action: 'APPROVE' | 'REJECT',
    currentNote: string | null,
  ) => {
    const note =
      window.prompt(
        `Enter moderation note for ${action.toLowerCase()} (optional):`,
        currentNote || '',
      ) ?? undefined;
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

  const filteredReviews = reviews.filter((r) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      const headline = (r.title || r.headline || '').toLowerCase();
      const content = (r.comment || r.content || '').toLowerCase();
      const reviewer = (r.reviewerName || '').toLowerCase();
      const product = (r.productId || '').toLowerCase();
      if (
        !headline.includes(q) &&
        !content.includes(q) &&
        !reviewer.includes(q) &&
        !product.includes(q)
      ) {
        return false;
      }
    }
    return true;
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Customer Reviews ({reviews.length})
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage and moderate customer reviews for your products.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadReviews}>
          Refresh
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {/* Filter and Search Bar matching Listings */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search reviews by keyword, product, reviewer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s.value}
              variant={statusFilter === s.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s.value)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading reviews">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : filteredReviews.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={reviews.length === 0 ? 'No customer reviews yet' : 'No matching reviews'}
          description={
            reviews.length === 0
              ? 'Customer reviews submitted for your products will appear here for moderation.'
              : 'Try clearing your search query or selecting a different status filter.'
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredReviews.map((r) => {
            const headline = r.title || r.headline || 'Review';
            const content = r.comment || r.content || 'No content provided.';
            return (
              <Card key={r.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="truncate text-sm font-semibold">{headline}</h3>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <div className="flex items-center gap-0.5 text-amber-500">
                          {[...Array(5)].map((_, i) => (
                            <Star
                              key={i}
                              className={`size-3 ${
                                i < r.rating
                                  ? 'fill-amber-500 text-amber-500'
                                  : 'text-muted-foreground/30'
                              }`}
                            />
                          ))}
                        </div>
                        {r.reviewerName && <span>by {r.reviewerName}</span>}
                        {r.verifiedPurchase && (
                          <Badge variant="outline" className="text-[10px] py-0 gap-1">
                            <CheckCircle2 className="size-2.5 text-success" />
                            Verified
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant={
                        r.status === 'APPROVED'
                          ? 'success'
                          : r.status === 'REJECTED'
                            ? 'destructive'
                            : 'warning'
                      }
                      className="ml-auto shrink-0 self-start"
                    >
                      {r.status}
                    </Badge>
                  </div>

                  <p className="line-clamp-3 text-[13px] text-foreground/90 leading-relaxed">
                    {content}
                  </p>

                  <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground pt-1">
                    <span>
                      Product:{' '}
                      <strong className="font-mono text-foreground">
                        {r.productId.slice(0, 8)}
                      </strong>
                    </span>
                    <span>•</span>
                    <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>

                  {r.moderationNote && (
                    <div className="rounded bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">Note: </span>
                      <span className="italic">{r.moderationNote}</span>
                    </div>
                  )}

                  <div className="mt-1 flex items-center justify-end gap-1.5 border-t border-border pt-2.5">
                    <Button
                      size="sm"
                      variant={r.status === 'APPROVED' ? 'outline' : 'default'}
                      onClick={() => handleAction(r.id, 'APPROVE', r.moderationNote)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleAction(r.id, 'REJECT', r.moderationNote)}
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
