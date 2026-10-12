import { useState, useEffect, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { BookOpen, RefreshCw, Search } from "lucide-react";
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

interface Product {
  id: string;
  title: string;
  brand?: string;
  status?: string;
  categoryId?: string;
  createdAt?: string;
}

export const AdminCatalog = () => {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadCatalog = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>("/products?limit=100");
      const list = Array.isArray(res)
        ? (res as Product[])
        : ((res as { products?: Product[]; data?: Product[] }).products ??
           (res as { products?: Product[]; data?: Product[] }).data ??
           []);
      setProducts(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error loading catalog");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== "ADMINISTRATOR") return;
    loadCatalog();
  }, [user]);

  if (user?.role !== "ADMINISTRATOR") return <Navigate to="/account" replace />;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.brand && p.brand.toLowerCase().includes(q)) ||
        p.id.toLowerCase().includes(q)
    );
  }, [products, searchQuery]);

  const activeCount = products.filter((p) => p.status === "ACTIVE" || !p.status).length;
  const uniqueBrands = new Set(products.map((p) => p.brand).filter(Boolean)).size;

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Catalog management</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Canonical master product catalog and multi-vendor category taxonomy.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadCatalog} disabled={isLoading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="error" title="Could not load catalog">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Master canonical catalog</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {products.length} products
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Standardized product identities with shared SKU variants</p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Total products" value={String(products.length)} hint="in database" />
          <KpiCard label="Active products" value={String(activeCount)} hint="published" />
          <KpiCard label="Verified brands" value={String(uniqueBrands || "—")} hint="in catalog" />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Canonical products list</CardTitle>
              <CardDescription>Search by title, brand, or canonical UUID</CardDescription>
            </div>
            <div className="relative min-w-[220px]">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search products or brand..."
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
              icon={BookOpen}
              title="No products found"
              description="No canonical products match the search query."
              actionLabel={searchQuery ? "Clear search" : undefined}
              onAction={() => setSearchQuery("")}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Product Title &amp; ID</TH>
                  <TH>Brand</TH>
                  <TH>Category</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Created</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <TD>
                      <div className="font-medium text-xs">{p.title}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{p.id}</div>
                    </TD>
                    <TD className="text-xs text-muted-foreground">{p.brand || "Generic"}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">
                      {p.categoryId ? p.categoryId.slice(0, 12) : "General"}
                    </TD>
                    <TD>
                      <Badge variant={p.status === "INACTIVE" ? "destructive" : "success"}>
                        {p.status || "ACTIVE"}
                      </Badge>
                    </TD>
                    <TD className="text-right text-xs text-muted-foreground">
                      {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}
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
