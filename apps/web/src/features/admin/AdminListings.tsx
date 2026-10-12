import { useState, useEffect, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { Layers, RefreshCw, Search, CheckCircle2, Ban } from "lucide-react";
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
import { formatMoney } from "../../lib/format";
import { cn } from "../../lib/utils";

interface Listing {
  id: string;
  productTitle?: string;
  skuCode?: string;
  sellerPrice: number;
  currency?: string;
  status: string;
  merchantId?: string;
  tenantId?: string;
  createdAt: string;
}

export const AdminListings = () => {
  const { user } = useAuth();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadListings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>("/admin/listings")
        .catch(() => apiClient<unknown>("/listings?limit=100"));
      const list = Array.isArray(res)
        ? (res as Listing[])
        : ((res as { listings?: Listing[] }).listings ?? []);
      setListings(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load listings");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== "ADMINISTRATOR") return;
    loadListings();
  }, [user]);

  if (user?.role !== "ADMINISTRATOR") return <Navigate to="/account" replace />;

  const handleToggleStatus = async (listing: Listing) => {
    const nextStatus = listing.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setUpdatingId(listing.id);
    try {
      await apiClient(`/listings/${listing.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadListings();
    } catch (err: unknown) {
      alert(`Status update failed: ${err instanceof Error ? err.message : "Error"}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return listings.filter((l) => {
      if (statusFilter !== "ALL" && l.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (l.productTitle && l.productTitle.toLowerCase().includes(q)) ||
        (l.skuCode && l.skuCode.toLowerCase().includes(q)) ||
        l.id.toLowerCase().includes(q) ||
        (l.tenantId && l.tenantId.toLowerCase().includes(q)) ||
        (l.merchantId && l.merchantId.toLowerCase().includes(q))
      );
    });
  }, [listings, searchQuery, statusFilter]);

  const activeCount = listings.filter((l) => l.status === "ACTIVE").length;
  const inactiveCount = listings.filter((l) => l.status !== "ACTIVE").length;
  const totalCatalogValue = listings.reduce((sum, l) => sum + (l.sellerPrice || 0), 0) / 100;
  const displayCurrency = listings.find((l) => l.currency)?.currency ?? "INR";

  const statusVariant = (s: string) => {
    switch (s) {
      case "ACTIVE":
        return "success" as const;
      case "INACTIVE":
      case "SUSPENDED":
        return "destructive" as const;
      default:
        return "warning" as const;
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Merchant listings</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Marketplace seller listings and offer management across all merchants.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadListings} disabled={isLoading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="error" title="Could not load listings">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total offer value</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalCatalogValue, displayCurrency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Sum of list prices across all active merchant offers</p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="All listings" value={String(listings.length)} hint="in database" />
          <KpiCard label="Active offers" value={String(activeCount)} hint="visible to customers" />
          <KpiCard label="Inactive / Suspended" value={String(inactiveCount)} hint="hidden from search" />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Catalog listings</CardTitle>
              <CardDescription>Search by product title, SKU code, or merchant tenant ID</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search listings..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                {["ALL", "ACTIVE", "INACTIVE", "DRAFT"].map((s) => (
                  <option key={s} value={s}>
                    {s === "ALL" ? "All statuses" : s}
                  </option>
                ))}
              </select>
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
              icon={Layers}
              title="No listings found"
              description="No seller listings match the specified filter criteria."
              actionLabel={statusFilter !== "ALL" || searchQuery ? "Clear filters" : undefined}
              onAction={() => {
                setStatusFilter("ALL");
                setSearchQuery("");
              }}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Product / SKU</TH>
                  <TH>Merchant</TH>
                  <TH className="text-right">Price</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH className="text-right">Actions</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <TD>
                      <div className="font-medium text-xs">{l.productTitle || "Marketplace Product"}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {l.skuCode || l.id.slice(0, 10)}
                      </div>
                    </TD>
                    <TD className="font-mono text-xs text-muted-foreground">
                      {l.merchantId || l.tenantId || "—"}
                    </TD>
                    <TD className="tnum text-right font-medium text-xs">
                      {formatMoney((l.sellerPrice || 0) / 100, l.currency || displayCurrency)}
                    </TD>
                    <TD>
                      <Badge variant={statusVariant(l.status)}>{l.status}</Badge>
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {l.createdAt ? new Date(l.createdAt).toLocaleDateString() : "—"}
                    </TD>
                    <TD className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={updatingId === l.id}
                        onClick={() => handleToggleStatus(l)}
                      >
                        {l.status === "ACTIVE" ? (
                          <>
                            <Ban className="mr-1 h-3 w-3 text-destructive" />
                            Suspend
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-600" />
                            Activate
                          </>
                        )}
                      </Button>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
