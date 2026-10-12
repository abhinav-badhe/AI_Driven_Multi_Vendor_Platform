import { useState, useEffect, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { Boxes, RefreshCw, Search } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { KpiCard } from "../../components/ui/kpi";
import { Table, THead, TH, TD } from "../../components/ui/table";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";

interface InventoryRecord {
  id: string;
  listingId: string;
  skuId?: string;
  tenantId?: string;
  onHandQuantity?: number;
  reservedQuantity?: number;
  nonSellableQuantity?: number;
  availableQuantity?: number;
  onHand?: number;
  reserved?: number;
  available?: number;
}

export const AdminInventory = () => {
  const { user } = useAuth();
  const [items, setItems] = useState<InventoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadInventory = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>("/admin/inventory")
        .catch(() => apiClient<unknown>("/inventory"));
      const list = Array.isArray(res)
        ? (res as InventoryRecord[])
        : ((res as { items?: InventoryRecord[] }).items ?? []);
      setItems(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load inventory");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== "ADMINISTRATOR") return;
    loadInventory();
  }, [user]);

  if (user?.role !== "ADMINISTRATOR") return <Navigate to="/account" replace />;

  const getOnHand = (item: InventoryRecord) => item.onHandQuantity ?? item.onHand ?? 0;
  const getReserved = (item: InventoryRecord) => item.reservedQuantity ?? item.reserved ?? 0;
  const getAvailable = (item: InventoryRecord) =>
    item.availableQuantity ?? item.available ?? Math.max(0, getOnHand(item) - getReserved(item));

  const totalOnHand = items.reduce((sum, it) => sum + getOnHand(it), 0);
  const totalReserved = items.reduce((sum, it) => sum + getReserved(it), 0);
  const totalAvailable = items.reduce((sum, it) => sum + getAvailable(it), 0);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.id.toLowerCase().includes(q) ||
        it.listingId.toLowerCase().includes(q) ||
        (it.tenantId && it.tenantId.toLowerCase().includes(q)) ||
        (it.skuId && it.skuId.toLowerCase().includes(q))
    );
  }, [items, searchQuery]);

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Platform inventory</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Multi-vendor warehouse stock levels, reservations, and sellable units across all merchants.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadInventory} disabled={isLoading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="error" title="Could not load inventory">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total available units</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {totalAvailable} units
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Across {items.length} marketplace inventory records</p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Total on-hand" value={String(totalOnHand)} hint="physical warehouse stock" />
          <KpiCard label="Reserved units" value={String(totalReserved)} hint="committed to checkout" />
          <KpiCard label="Inventory items" value={String(items.length)} hint="tracked SKUs" />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Inventory allocations</CardTitle>
              <CardDescription>Real-time physical stock and reserved quantities by listing</CardDescription>
            </div>
            <div className="relative min-w-[220px]">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search listing or tenant ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2 py-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No inventory records"
              description="Inventory allocations will appear here when merchants initialize stock for their listings."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Listing ID</TH>
                  <TH>Tenant / Merchant</TH>
                  <TH className="text-right">On Hand</TH>
                  <TH className="text-right">Reserved</TH>
                  <TH className="text-right">Sellable Available</TH>
                  <TH className="text-right">Status</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((it) => {
                  const onHand = getOnHand(it);
                  const reserved = getReserved(it);
                  const available = getAvailable(it);
                  return (
                    <tr key={it.id}>
                      <TD className="font-mono text-xs">
                        <div>{it.listingId}</div>
                        {it.skuId && <div className="text-[11px] text-muted-foreground">{it.skuId}</div>}
                      </TD>
                      <TD className="font-mono text-xs text-muted-foreground">
                        {it.tenantId || "merchant-tenant"}
                      </TD>
                      <TD className="tnum text-right font-medium text-xs">{onHand}</TD>
                      <TD className="tnum text-right text-xs text-muted-foreground">{reserved}</TD>
                      <TD className="tnum text-right font-semibold text-xs text-emerald-600">
                        {available}
                      </TD>
                      <TD className="text-right">
                        <Badge variant={available > 0 ? "success" : "destructive"}>
                          {available > 0 ? "In stock" : "Out of stock"}
                        </Badge>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
