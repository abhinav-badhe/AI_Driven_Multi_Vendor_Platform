import { useState, useEffect, useMemo } from "react";
import { Boxes, Minus, Plus, Search } from "lucide-react";
import { merchantApi, type InventoryItemDto, type MerchantListingDetailDto } from "./api/merchant";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { Input } from "../../components/ui/input";

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
  const [query, setQuery] = useState("");
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
        (details || []).map((detail) => ({ detail, item: byListing.get(detail.id) ?? null }))
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load inventory.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.detail.productTitle.toLowerCase().includes(q) ||
        (r.detail.brand ?? "").toLowerCase().includes(q) ||
        r.detail.skuCode.toLowerCase().includes(q)
    );
  }, [rows, query]);

  const deltaFor = (listingId: string): number => {
    const raw = parseInt(deltas[listingId] ?? "10", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };

  const handleAdjust = async (row: StockRow, sign: 1 | -1) => {
    if (!row.item) {
      setError(`“${row.detail.productTitle}” has no stock record yet. Add stock from the listing first.`);
      return;
    }
    const qty = deltaFor(row.detail.id);
    if (qty <= 0) {
      setError("Enter a quantity greater than 0.");
      return;
    }
    setAdjustingId(row.item.id);
    setError(null);
    try {
      await merchantApi.adjustInventory(row.item.id, sign * qty, "Merchant manual stock update");
      setNotice(
        `${sign > 0 ? "Added" : "Removed"} ${qty} units ${sign > 0 ? "to" : "from"} “${row.detail.productTitle}”.`
      );
      setTimeout(() => setNotice(null), 4000);
      await fetchInventory();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Could not update “${row.detail.productTitle}”: ${err.message}`
          : "Stock update failed."
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
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products or SKUs"
            aria-label="Search inventory"
            className="pl-8"
          />
        </div>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {isLoading ? (
        <div aria-label="Loading inventory">
          <TableSkeleton rows={6} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={rows.length === 0 ? "No stock to manage yet" : "No products match"}
          description={
            rows.length === 0
              ? "Create a listing first — its stock record will appear here."
              : "Try a different search."
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {filtered.map(({ detail, item }) => {
                const available = detail.availableQuantity;
                const busy = adjustingId === item?.id;
                return (
                  <li key={detail.id} className="flex flex-wrap items-center gap-3 p-3">
                    {detail.thumbnailUrl ? (
                      <img
                        src={detail.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="size-11 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <Boxes className="size-4 text-muted-foreground" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-sm font-medium">{detail.productTitle}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {detail.brand && <span>{detail.brand}</span>}
                        <span className="font-mono">{detail.skuCode}</span>
                      </p>
                    </div>

                    <div className="tnum flex shrink-0 items-center gap-3 text-[13px]">
                      <span title="On hand">
                        <span className="font-semibold">{item?.onHandQuantity ?? "—"}</span>{" "}
                        <span className="text-muted-foreground">on hand</span>
                      </span>
                      <span title="Reserved">
                        <span className="font-semibold">{item?.reservedQuantity ?? "—"}</span>{" "}
                        <span className="text-muted-foreground">reserved</span>
                      </span>
                      {available == null ? (
                        <Badge variant="outline">No record</Badge>
                      ) : available <= 0 ? (
                        <Badge variant="destructive">Out of stock</Badge>
                      ) : available <= 5 ? (
                        <Badge variant="warning">Low · {available}</Badge>
                      ) : (
                        <Badge variant="success">{available} available</Badge>
                      )}
                    </div>

                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        aria-label={`Quantity to adjust for ${detail.productTitle}`}
                        value={deltas[detail.id] ?? "10"}
                        onChange={(e) =>
                          setDeltas((d) => ({ ...d, [detail.id]: e.target.value }))
                        }
                        className="tnum h-8 w-20"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !item}
                        onClick={() => handleAdjust({ detail, item }, 1)}
                        aria-label={`Add stock to ${detail.productTitle}`}
                      >
                        {busy ? "Saving…" : <Plus aria-hidden />}
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
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
