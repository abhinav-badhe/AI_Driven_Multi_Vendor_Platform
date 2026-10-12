import { useState, useEffect, useMemo } from 'react';
import { Inbox, Search } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input } from '../../components/ui/input';

export interface ReturnItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ReturnRequestDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  status:
    'REQUESTED' | 'APPROVED' | 'REJECTED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED';
  items: ReturnItemDto[];
  createdAt: string;
}

type ReturnStatusFilter = 'ALL' | ReturnRequestDto['status'];

const statusVariant = (s: ReturnRequestDto['status']) =>
  s === 'COMPLETED'
    ? ('success' as const)
    : s === 'REJECTED'
      ? ('destructive' as const)
      : s === 'REQUESTED'
        ? ('warning' as const)
        : s === 'RECEIVED'
          ? ('default' as const)
          : ('outline' as const);

export const MerchantReturns = () => {
  const { user } = useAuth();
  const [returns, setReturns] = useState<ReturnRequestDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReturnStatusFilter>('ALL');

  const loadReturns = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<ReturnRequestDto[]>('/fulfillment/returns');
      setReturns(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load returns.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [user]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return returns.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.id.toLowerCase().includes(q) ||
        r.sellerOrderId.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q)
      );
    });
  }, [returns, query, statusFilter]);

  const handleUpdate = async (
    ret: ReturnRequestDto,
    status: ReturnRequestDto['status'],
    options?: { restock?: boolean; restockCondition?: 'SELLABLE' | 'DEFECTIVE' },
  ) => {
    setActingId(ret.id);
    setError(null);
    try {
      await apiClient<ReturnRequestDto>(`/fulfillment/returns/${ret.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, options }),
      });
      setNotice(`Return marked as ${status.toLowerCase()}.`);
      setTimeout(() => setNotice(null), 4000);
      await loadReturns();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Returns ({returns.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Approve requests, confirm receipts, and restock or write off items.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadReturns}>
          Refresh
        </Button>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by RMA, order, or reason"
            aria-label="Search returns"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by return status">
          {(
            [
              'ALL',
              'REQUESTED',
              'APPROVED',
              'IN_TRANSIT',
              'RECEIVED',
              'COMPLETED',
              'REJECTED',
            ] as ReturnStatusFilter[]
          ).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL'
                ? 'All'
                : s === 'IN_TRANSIT'
                  ? 'In transit'
                  : s.charAt(0) + s.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading returns">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No return requests"
          description={
            returns.length === 0
              ? 'Customer return requests for your store will appear here.'
              : 'No return requests match this search or status filter.'
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((ret) => {
            const busy = actingId === ret.id;
            return (
              <Card key={ret.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">RMA #{ret.id.slice(0, 8)}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span>Order #{ret.sellerOrderId.slice(0, 8)}</span>
                        <span>·</span>
                        <span>{new Date(ret.createdAt).toLocaleDateString()}</span>
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">{ret.id}</p>
                    </div>
                    <Badge
                      variant={statusVariant(ret.status)}
                      className="ml-auto shrink-0 self-start"
                    >
                      {ret.status}
                    </Badge>
                  </div>

                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-medium text-foreground">“{ret.reason}”</p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {ret.items?.length || 1}{' '}
                    {(ret.items?.length || 1) === 1 ? 'return item' : 'return items'} requested
                  </p>

                  <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
                    {ret.status === 'REQUESTED' && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => handleUpdate(ret, 'APPROVED')}
                        >
                          {busy ? 'Saving…' : 'Approve'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleUpdate(ret, 'REJECTED')}
                          className="text-destructive hover:text-destructive"
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {(ret.status === 'APPROVED' || ret.status === 'IN_TRANSIT') && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => handleUpdate(ret, 'RECEIVED')}
                      >
                        {busy ? 'Saving…' : 'Mark received'}
                      </Button>
                    )}
                    {ret.status === 'RECEIVED' && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            handleUpdate(ret, 'COMPLETED', {
                              restock: true,
                              restockCondition: 'SELLABLE',
                            })
                          }
                        >
                          {busy ? 'Saving…' : 'Restock & refund'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            handleUpdate(ret, 'COMPLETED', {
                              restock: false,
                              restockCondition: 'DEFECTIVE',
                            })
                          }
                          className="text-destructive hover:text-destructive"
                        >
                          Write off
                        </Button>
                      </>
                    )}
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
