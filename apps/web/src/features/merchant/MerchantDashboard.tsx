import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { PackageSearch } from "lucide-react";
import { merchantApi, type MerchantProfileDto, type MerchantListingDto, type InventoryItemDto, type SellerOrderDto, type FinancialSummaryDto } from "./api/merchant";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, Skeleton } from "../../components/ui/empty";
import { KpiCard } from "../../components/ui/kpi";
import { Table, THead, TH, TD } from "../../components/ui/table";
import { formatMoney } from "../../lib/format";
import { cn } from "../../lib/utils";

export const MerchantDashboard = () => {
  const { user, login } = useAuth();
  const [profile, setProfile] = useState<MerchantProfileDto | null>(null);
  const [listings, setListings] = useState<MerchantListingDto[]>([]);
  const [inventory, setInventory] = useState<InventoryItemDto[]>([]);
  const [orders, setOrders] = useState<SellerOrderDto[]>([]);
  const [financials, setFinancials] = useState<FinancialSummaryDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMerchantData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [prof, list, inv, ord] = await Promise.all([
          merchantApi.getProfile().catch(() => null),
          merchantApi.getMyListings().catch(() => []),
          merchantApi.getMyInventory().catch(() => []),
          merchantApi.getSellerOrders().catch(() => []),
        ]);
        setProfile(prof);
        setListings(list);
        setInventory(inv);
        setOrders(ord);

        const merchantId = prof?.id ?? user?.tenantId ?? "tenant-merchant-1";
        const fin = await merchantApi.getFinancialSummary(merchantId).catch(() => null);
        setFinancials(fin);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load merchant data");
      } finally {
        setIsLoading(false);
      }
    };
    loadMerchantData();
  }, [user]);

  if (user?.role !== "MERCHANT" && user?.role !== "ADMINISTRATOR") {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Seller hub</CardTitle>
            <CardDescription>Sign in with a merchant account to manage listings and orders.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={async () => {
                await login({ email: "merchant@example.com", password: "password123" });
              }}
            >
              Sign in as demo merchant
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  const totalStock = inventory.reduce((sum, item) => sum + (item.onHandQuantity - item.reservedQuantity), 0);
  const totalSales = orders.reduce((sum, ord) => sum + ord.totalAmount, 0) / 100;
  // Single-currency assumption like the rest of the console: every amount
  // renders in the store's own currency, never a hardcoded symbol.
  const displayCurrency =
    orders.find((o) => o.currency)?.currency ??
    listings.find((l) => l.currency)?.currency ??
    "USD";

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Seller hub</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            {profile?.businessName ?? "Apex Electronics"}
            <Badge variant="success">{profile?.verificationStatus ?? "Verified"}</Badge>
          </p>
        </div>
        <div className="flex gap-1.5">
          <Link to="/merchant/listings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Manage listings ({listings.length})
          </Link>
          <Link to="/merchant/orders" className={cn(buttonVariants({ size: "sm" }))}>
            Fulfill orders ({orders.length})
          </Link>
        </div>
      </div>

      {error && (
        <Alert tone="error" title="Could not load dashboard data">
          {error}
        </Alert>
      )}

      {/* Bento: wide revenue card + narrow supporting KPIs (not 4 equal boxes) */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Gross revenue</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalSales, displayCurrency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Before settlement deductions</p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Active listings" value={String(listings.length)} hint="synced" />
          <KpiCard label="Sellable units" value={`${totalStock}`} hint="across listings" />
          <KpiCard label="Open orders" value={String(orders.length)} hint="to fulfill" />
        </div>
      </div>

      {financials && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>Settlement balance</CardTitle>
                <CardDescription>Double-entry ledger accounts</CardDescription>
              </div>
              <Badge variant="success">{financials.ledgerCount} ledger entries</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Current balance", value: financials.currentBalance },
                { label: "Total earnings", value: financials.totalEarnings },
                { label: "Platform commission", value: financials.totalCommissions },
                { label: "Refunds", value: financials.totalRefunds },
              ].map((row) => (
                <div key={row.label} className="rounded-md bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{row.label}</dt>
                  <dd className="tnum mt-0.5 text-sm font-semibold">
                    {formatMoney(row.value / 100, financials?.currency ?? displayCurrency)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Recent orders</CardTitle>
            <Link to="/merchant/orders" className="text-[13px] font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title="No orders yet"
              description="Orders assigned to your store will appear here. Create a listing to start selling."
              actionLabel="Manage listings"
              onAction={() => undefined}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Order</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Total</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {orders.slice(0, 5).map((ord) => (
                  <tr key={ord.id}>
                    <TD className="font-mono text-xs">#{ord.id.slice(0, 8)}</TD>
                    <TD className="text-muted-foreground">
                      {new Date(ord.createdAt).toLocaleDateString()}
                    </TD>
                    <TD className="tnum text-right font-medium">
                      {formatMoney(ord.totalAmount / 100, ord.currency)}
                    </TD>
                    <TD>
                      <Badge variant="outline">{ord.status}</Badge>
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
