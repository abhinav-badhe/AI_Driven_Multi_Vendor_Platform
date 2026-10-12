import { useState, useEffect, useMemo } from 'react';
import { Boxes, Minus, Plus, Search } from 'lucide-react';
import { merchantApi, type InventoryItemDto, type MerchantListingDetailDto } from './api/merchant';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input } from '../../components/ui/input';

type StockFilter = 'ALL' | 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

interface StockRow {
  detail: MerchantListingDetailDto;
  item: InventoryItemDto | null;
}

export const MerchantInventory = () => {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  // Per-row quantities — one shared input corrupted every row, so each row
  // owns its own value keyed by listing id.
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockFilter>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchInventory = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [details, items] = await Promise.all([
        merchantApi.getMyListingDetails(),
        merchantApi.getMyInventory().catch(() => [] as InventoryItemDto[]),
      ]);
      const byListing = new Map((items || []).map((it) => [it.listingId, it]));
      setRows(
        (details || []).map((detail) => ({ detail, item: byListing.get(detail.id) ?? null })),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load inventory.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const available =
        r.item != null
          ? Math.max(
              0,
              r.item.onHandQuantity - r.item.reservedQuantity - r.item.nonSellableQuantity,
            )
          : r.detail.availableQuantity;
      if (statusFilter === 'IN_STOCK' && (available == null || available <= 5)) return false;
      if (statusFilter === 'LOW_STOCK' && (available == null || available <= 0 || available > 5))
        return false;
      if (statusFilter === 'OUT_OF_STOCK' && available != null && available > 0) return false;

      if (!q) return true;
      return (
        r.detail.productTitle.toLowerCase().includes(q) ||
        (r.detail.brand ?? '').toLowerCase().includes(q) ||
        r.detail.skuCode.toLowerCase().includes(q)
      );
    });
  }, [rows, query, statusFilter]);

  const deltaFor = (listingId: string): number => {
    const raw = parseInt(deltas[listingId] ?? '10', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };

  const handleAdjust = async (row: StockRow, sign: 1 | -1) => {
    const qty = deltaFor(row.detail.id);
    if (qty <= 0) {
      setError('Enter a quantity greater than 0.');
      return;
    }

    if (!row.item) {
      if (sign < 0) {
        setError(`“${row.detail.productTitle}” has no stock record yet.`);
        return;
      }
      setAdjustingId(row.detail.id);
      setError(null);
      try {
        await merchantApi.initInventory({ listingId: row.detail.id, initialOnHandQuantity: qty });
        setNotice(`Initialized ${qty} units for “${row.detail.productTitle}”.`);
        setTimeout(() => setNotice(null), 4000);
        await fetchInventory();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to initialize stock.');
      } finally {
        setAdjustingId(null);
      }
      return;
    }

    setAdjustingId(row.item.id);
    setError(null);
    try {
      await merchantApi.adjustInventory(row.item.id, sign * qty, 'Merchant manual stock update');
      setNotice(
        `${sign > 0 ? 'Added' : 'Removed'} ${qty} units ${sign > 0 ? 'to' : 'from'} “${row.detail.productTitle}”.`,
      );
      setTimeout(() => setNotice(null), 4000);
      await fetchInventory();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Could not update “${row.detail.productTitle}”: ${err.message}`
          : 'Stock update failed.',
      );
    } finally {
      setAdjustingId(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inventory ({rows.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            On-hand, reserved, and available stock per product.
          </p>
        </div>
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
            placeholder="Search by product, brand, or SKU"
            aria-label="Search inventory"
            className="pl-8"
          />
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter by stock status">
          {(['ALL', 'IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'] as StockFilter[]).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL'
                ? 'All'
                : s === 'IN_STOCK'
                  ? 'In stock'
                  : s === 'LOW_STOCK'
                    ? 'Low stock'
                    : 'Out of stock'}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading inventory">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={rows.length === 0 ? 'No stock to manage yet' : 'No products match'}
          description={
            rows.length === 0
              ? 'Create a listing first — its stock record will appear here.'
              : 'Try a different search or status filter.'
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map(({ detail, item }) => {
            const available = detail.availableQuantity;
            const busy = adjustingId === item?.id;
            return (
              <Card key={detail.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex gap-3">
                    {detail.thumbnailUrl ? (
                      <img
                        src={detail.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="size-16 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <Boxes className="size-5 text-muted-foreground" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{detail.productTitle}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {detail.brand && <span>{detail.brand}</span>}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {detail.skuCode}
                      </p>
                    </div>
                    {available == null ? (
                      <Badge variant="outline" className="ml-auto shrink-0 self-start">
                        No record
                      </Badge>
                    ) : available <= 0 ? (
                      <Badge variant="destructive" className="ml-auto shrink-0 self-start">
                        Out of stock
                      </Badge>
                    ) : available <= 5 ? (
                      <Badge variant="warning" className="ml-auto shrink-0 self-start">
                        Low · {available}
                      </Badge>
                    ) : (
                      <Badge variant="success" className="ml-auto shrink-0 self-start">
                        In stock
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-baseline gap-2">
                    <p className="tnum text-base font-semibold">
                      {available == null ? '0' : available}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        units available
                      </span>
                    </p>
                  </div>

                  <p className="tnum text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {item?.onHandQuantity ?? detail.onHandQuantity ?? 0}
                    </span>{' '}
                    on hand ·{' '}
                    <span className="font-medium text-foreground">
                      {item?.reservedQuantity ?? detail.reservedQuantity ?? 0}
                    </span>{' '}
                    reserved
                  </p>

                  <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      aria-label={`Quantity to adjust for ${detail.productTitle}`}
                      value={deltas[detail.id] ?? '10'}
                      onChange={(e) => setDeltas((d) => ({ ...d, [detail.id]: e.target.value }))}
                      className="tnum h-8 w-20"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleAdjust({ detail, item }, 1)}
                      aria-label={`Add stock to ${detail.productTitle}`}
                    >
                      {busy ? 'Saving…' : <Plus aria-hidden />}
                      Add
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !item}
                      onClick={() => handleAdjust({ detail, item }, -1)}
                      aria-label={`Remove stock from ${detail.productTitle}`}
                    >
                      <Minus aria-hidden />
                      Remove
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
