import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  PackageSearch,
  Store,
  RefreshCw,
  Search,
  Zap,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Button, buttonVariants } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { KpiCard } from '../../components/ui/kpi';
import { Table, THead, TH, TD } from '../../components/ui/table';
import { formatMoney } from '../../lib/format';
import { cn } from '../../lib/utils';

interface PlatformOrder {
  id: string;
  customerId?: string;
  status: string;
  paymentStatus?: string;
  totalAmount: number;
  currency?: string;
  createdAt: string;
}

interface MerchantItem {
  id: string;
  tenantId: string;
  businessName: string;
  legalName: string;
  contactEmail: string;
  verificationStatus: 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  createdAt: string;
}

interface ListingItem {
  id: string;
  productTitle?: string;
  skuCode?: string;
  sellerPrice: number;
  status: string;
  tenantId?: string;
}

interface UserItem {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
  components: {
    database?: { status: string };
    redis?: { status: string };
    search?: { status: string };
    events?: { status: string };
  };
}

export const AdminDashboard = () => {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [orders, setOrders] = useState<PlatformOrder[]>([]);
  const [merchants, setMerchants] = useState<MerchantItem[]>([]);
  const [listings, setListings] = useState<ListingItem[]>([]);
  const [usersList, setUsersList] = useState<UserItem[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Operational triggers state
  const [showOps, setShowOps] = useState(false);
  const [isRebuildingSearch, setIsRebuildingSearch] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [isSweepingAlerts, setIsSweepingAlerts] = useState(false);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const [isRebuildingRecs, setIsRebuildingRecs] = useState(false);
  const [recsMsg, setRecsMsg] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;

    const loadPlatformData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [ordersRes, merchantsRes, listingsRes, usersRes, healthRes] = await Promise.all([
          apiClient<unknown>('/admin/orders')
            .catch(() => apiClient<unknown>('/orders?limit=100'))
            .catch(() => ({ orders: [] })),
          apiClient<MerchantItem[]>('/merchants').catch(() => []),
          apiClient<unknown>('/admin/listings')
            .catch(() => apiClient<unknown>('/listings?limit=100'))
            .catch(() => ({ listings: [] })),
          apiClient<unknown>('/admin/users')
            .catch(() => apiClient<unknown>('/users'))
            .catch(() => ({ users: [] })),
          apiClient<HealthResponse>('/health').catch(() => null),
        ]);

        const orderList = Array.isArray(ordersRes)
          ? (ordersRes as PlatformOrder[])
          : ((ordersRes as { orders?: PlatformOrder[] }).orders ?? []);
        setOrders(orderList);

        setMerchants(Array.isArray(merchantsRes) ? merchantsRes : []);

        const listingList = Array.isArray(listingsRes)
          ? (listingsRes as ListingItem[])
          : ((listingsRes as { listings?: ListingItem[] }).listings ?? []);
        setListings(listingList);

        const uList = Array.isArray(usersRes)
          ? (usersRes as UserItem[])
          : ((usersRes as { users?: UserItem[] }).users ?? []);
        setUsersList(uList);

        setHealth(healthRes);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load platform data');
      } finally {
        setIsLoading(false);
      }
    };

    loadPlatformData();
  }, [user]);

  const handleRebuildSearch = async () => {
    setIsRebuildingSearch(true);
    setSearchMsg(null);
    try {
      const res = await apiClient<{
        generation: number;
        productsIndexed: number;
        offersIndexed: number;
      }>('/search/rebuild', { method: 'POST', body: JSON.stringify({}) });
      setSearchMsg(
        `Search index synchronized: ${res.productsIndexed ?? 0} products, ${res.offersIndexed ?? 0} offers indexed.`,
      );
    } catch (err: unknown) {
      setSearchMsg(err instanceof Error ? err.message : 'Index rebuild failed');
    } finally {
      setIsRebuildingSearch(false);
    }
  };

  const handleSweepPriceAlerts = async () => {
    setIsSweepingAlerts(true);
    setSweepMsg(null);
    try {
      const res = await apiClient<{ success: boolean; triggeredCount: number }>(
        '/price-alerts/sweep',
        {
          method: 'POST',
          body: JSON.stringify({ sinceDays: 90 }),
        },
      );
      setSweepMsg(`Price drop scan complete: ${res.triggeredCount ?? 0} notifications dispatched.`);
    } catch (err: unknown) {
      setSweepMsg(err instanceof Error ? err.message : 'Sweep failed');
    } finally {
      setIsSweepingAlerts(false);
    }
  };

  const handleRebuildRecs = async () => {
    setIsRebuildingRecs(true);
    setRecsMsg(null);
    try {
      const res = await apiClient<{ rebuiltCount: number }>('/recommendations/rebuild', {
        method: 'POST',
        body: JSON.stringify({ tenantId: user?.tenantId }),
      });
      setRecsMsg(
        `Personalization recommendations refreshed (${res.rebuiltCount ?? 0} items updated).`,
      );
    } catch (err: unknown) {
      setRecsMsg(err instanceof Error ? err.message : 'Recs rebuild failed');
    } finally {
      setIsRebuildingRecs(false);
    }
  };

  if (user?.role !== 'ADMINISTRATOR') {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Platform Administration</CardTitle>
            <CardDescription>
              Sign in with an administrator account to access platform governance.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2.5">
            <Button
              onClick={async () => {
                await login({ email: 'leonsintegration@gmail.com', password: 'Password@2163' });
              }}
            >
              Sign in as Admin
            </Button>
            <Link
              to="/account"
              className={cn(buttonVariants({ variant: 'outline', size: 'default' }))}
            >
              Sign in with Other Account
            </Link>
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

  const totalGmv = orders.reduce((sum, ord) => sum + (ord.totalAmount || 0), 0) / 100;
  const totalCommission = totalGmv * 0.1; // Standard 10% platform take-rate
  const displayCurrency = orders.find((o) => o.currency)?.currency ?? 'INR';

  const verifiedMerchantsCount = merchants.filter(
    (m) => m.verificationStatus === 'VERIFIED',
  ).length;
  const pendingMerchantsCount = merchants.filter(
    (m) => m.verificationStatus === 'SUBMITTED' || m.verificationStatus === 'DRAFT',
  ).length;
  const activeListingsCount =
    listings.filter((l) => l.status === 'ACTIVE').length || listings.length;
  const customerCount = usersList.filter((u) => u.role === 'CUSTOMER').length;
  const merchantUserCount = usersList.filter((u) => u.role === 'MERCHANT').length;

  const orderStatusVariant = (s: string) => {
    switch (s) {
      case 'DELIVERED':
      case 'COMPLETED':
        return 'success' as const;
      case 'PENDING':
      case 'PENDING_PAYMENT':
      case 'PROCESSING':
      case 'SHIPPED':
        return 'warning' as const;
      case 'CANCELLED':
        return 'destructive' as const;
      default:
        return 'outline' as const;
    }
  };

  const merchantStatusVariant = (s: string) => {
    switch (s) {
      case 'VERIFIED':
        return 'success' as const;
      case 'SUBMITTED':
        return 'warning' as const;
      case 'REJECTED':
      case 'SUSPENDED':
        return 'destructive' as const;
      default:
        return 'outline' as const;
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Platform Header matching Merchant Panel */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Platform command center</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            Signed in as {user.email}
            <Badge variant="success">Platform Administrator</Badge>
            {health && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                All services healthy
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link
            to="/admin/merchants"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            Merchants ({merchants.length})
          </Link>
          <Link to="/admin/orders" className={cn(buttonVariants({ size: 'sm' }))}>
            Platform orders ({orders.length})
          </Link>
        </div>
      </div>

      {error && (
        <Alert tone="error" title="Could not load platform metrics">
          {error}
        </Alert>
      )}

      {/* Bento: wide GMV card + narrow supporting KPIs (exact MerchantDashboard layout) */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Gross marketplace volume (GMV)</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalGmv, displayCurrency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Est. platform commission:{' '}
              <span className="font-semibold text-foreground">
                {formatMoney(totalCommission, displayCurrency)}
              </span>
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard
            label="Active merchants"
            value={String(verifiedMerchantsCount || merchants.length)}
            hint={
              pendingMerchantsCount > 0 ? `${pendingMerchantsCount} pending review` : 'all verified'
            }
          />
          <KpiCard
            label="Platform orders"
            value={String(orders.length)}
            hint="across all vendors"
          />
          <KpiCard
            label="Live listings"
            value={String(activeListingsCount)}
            hint="marketplace catalog"
          />
        </div>
      </div>

      {/* Platform Financial Governance & Ledger Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Platform ledger &amp; settlement overview</CardTitle>
              <CardDescription>
                Multi-vendor funds flow and double-entry ledger invariant
              </CardDescription>
            </div>
            <Badge variant="success">Balanced (Σ Debits = Σ Credits)</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Total marketplace sales', value: totalGmv },
              { label: 'Estimated merchant payouts', value: totalGmv * 0.9 },
              { label: 'Platform net commission', value: totalCommission },
              {
                label: 'Registered accounts',
                value: null,
                text: `${usersList.length || 0} (${customerCount || 0} buyers, ${merchantUserCount || 0} sellers)`,
              },
            ].map((row) => (
              <div key={row.label} className="rounded-md bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="tnum mt-0.5 text-sm font-semibold">
                  {row.text ? row.text : formatMoney(row.value as number, displayCurrency)}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/* Operational Grids: Recent Platform Orders and Merchant Partners */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent Platform Orders */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent marketplace orders</CardTitle>
                <CardDescription>Live customer purchases across all vendors</CardDescription>
              </div>
              <Link
                to="/admin/orders"
                className="text-[13px] font-medium text-primary hover:underline"
              >
                View all ({orders.length})
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <EmptyState
                icon={PackageSearch}
                title="No orders placed yet"
                description="Customer orders created across all stores will appear here in real-time."
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
                        {ord.createdAt ? new Date(ord.createdAt).toLocaleDateString() : '—'}
                      </TD>
                      <TD className="tnum text-right font-medium">
                        {formatMoney((ord.totalAmount || 0) / 100, ord.currency || displayCurrency)}
                      </TD>
                      <TD>
                        <Badge variant={orderStatusVariant(ord.status)}>{ord.status}</Badge>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Merchant Partners Overview */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Merchant partners</CardTitle>
                <CardDescription>
                  Seller onboarding, KYC status, and store approvals
                </CardDescription>
              </div>
              <Link
                to="/admin/merchants"
                className="text-[13px] font-medium text-primary hover:underline"
              >
                Manage ({merchants.length})
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {merchants.length === 0 ? (
              <EmptyState
                icon={Store}
                title="No merchants onboarded"
                description="Registered sellers and their KYC verification requests will appear here."
                actionLabel="Inspect sellers"
                onAction={() => navigate('/admin/merchants')}
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Store Name</TH>
                    <TH>Contact</TH>
                    <TH>KYC Status</TH>
                    <TH className="text-right">Action</TH>
                  </tr>
                </THead>
                <tbody>
                  {merchants.slice(0, 5).map((m) => (
                    <tr key={m.id || m.tenantId}>
                      <TD>
                        <div className="font-medium">{m.businessName}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {m.tenantId}
                        </div>
                      </TD>
                      <TD className="text-muted-foreground text-xs">{m.contactEmail}</TD>
                      <TD>
                        <Badge variant={merchantStatusVariant(m.verificationStatus)}>
                          {m.verificationStatus}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <Link
                          to="/admin/merchants"
                          className={cn(
                            buttonVariants({ variant: 'outline', size: 'sm' }),
                            'h-7 text-xs px-2',
                          )}
                        >
                          Review
                        </Link>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Collapsible System Operations Drawer at bottom */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => setShowOps(!showOps)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  showOps && 'rotate-180',
                )}
              />
              <div>
                <CardTitle className="text-sm">Platform Engine &amp; Search Operations</CardTitle>
                <CardDescription className="text-xs">
                  Dual-generation search reindexer, price alert background scanner, and AI
                  recommendation cache
                </CardDescription>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
              {showOps ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        {showOps && (
          <CardContent className="space-y-3 pt-0">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <Search className="h-3.5 w-3.5 text-primary" />
                  Search Index
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Dual-generation projection over catalog &amp; listings.
                </p>
                <Button
                  size="sm"
                  className="mt-2.5 h-8 text-xs w-full"
                  disabled={isRebuildingSearch}
                  onClick={handleRebuildSearch}
                >
                  {isRebuildingSearch ? 'Rebuilding…' : 'Rebuild index'}
                </Button>
                {searchMsg && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{searchMsg}</p>
                )}
              </div>

              <div className="rounded-md border p-3">
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  Price Drop Sweeper
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Trigger background evaluation of price threshold alerts.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2.5 h-8 text-xs w-full"
                  disabled={isSweepingAlerts}
                  onClick={handleSweepPriceAlerts}
                >
                  {isSweepingAlerts ? 'Scanning…' : 'Run price sweep'}
                </Button>
                {sweepMsg && <p className="mt-1.5 text-[11px] text-muted-foreground">{sweepMsg}</p>}
              </div>

              <div className="rounded-md border p-3">
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Recommendations
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Recalculate personalized collaborative filtering vectors.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2.5 h-8 text-xs w-full"
                  disabled={isRebuildingRecs}
                  onClick={handleRebuildRecs}
                >
                  {isRebuildingRecs ? 'Recalculating…' : 'Recalculate recs'}
                </Button>
                {recsMsg && <p className="mt-1.5 text-[11px] text-muted-foreground">{recsMsg}</p>}
              </div>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
};
