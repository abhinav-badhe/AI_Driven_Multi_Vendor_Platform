import { useState, useEffect, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { PackageSearch, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Button } from '../../components/ui/button';
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
import { Input } from '../../components/ui/input';
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

export const AdminOrders = () => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<PlatformOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const loadOrders = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>('/admin/orders').catch(() =>
        apiClient<unknown>('/orders?limit=100'),
      );
      const list = Array.isArray(res)
        ? (res as PlatformOrder[])
        : ((res as { orders?: PlatformOrder[] }).orders ?? []);
      setOrders(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load platform orders');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadOrders();
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
      if (!q) return true;
      return (
        o.id.toLowerCase().includes(q) || (o.customerId && o.customerId.toLowerCase().includes(q))
      );
    });
  }, [orders, searchQuery, statusFilter]);

  const totalSales = orders.reduce((sum, ord) => sum + (ord.totalAmount || 0), 0) / 100;
  const displayCurrency = orders.find((o) => o.currency)?.currency ?? 'INR';
  const deliveredCount = orders.filter(
    (o) => o.status === 'DELIVERED' || o.status === 'COMPLETED',
  ).length;
  const activeFulfillmentCount = orders.filter(
    (o) => o.status === 'PENDING' || o.status === 'CONFIRMED' || o.status === 'SHIPPED',
  ).length;

  const statusVariant = (s: string) => {
    switch (s) {
      case 'DELIVERED':
      case 'COMPLETED':
        return 'success' as const;
      case 'PENDING':
      case 'CONFIRMED':
      case 'SHIPPED':
        return 'warning' as const;
      case 'CANCELLED':
        return 'destructive' as const;
      default:
        return 'outline' as const;
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Platform orders</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Customer transactions and order fulfillment across all marketplace stores.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadOrders} disabled={isLoading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert tone="error" title="Could not load orders">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total platform volume</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalSales, displayCurrency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {orders.length} orders to date
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="All orders" value={String(orders.length)} hint="recorded" />
          <KpiCard
            label="In fulfillment"
            value={String(activeFulfillmentCount)}
            hint="pending/in-transit"
          />
          <KpiCard label="Delivered" value={String(deliveredCount)} hint="successfully received" />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Orders list</CardTitle>
              <CardDescription>
                Filter by status or search by Order ID and Customer ID
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search by ID..."
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
                {['ALL', 'PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].map((s) => (
                  <option key={s} value={s}>
                    {s === 'ALL' ? 'All statuses' : s}
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
              icon={PackageSearch}
              title="No orders found"
              description="No platform orders match the specified filter criteria."
              actionLabel={statusFilter !== 'ALL' || searchQuery ? 'Clear filters' : undefined}
              onAction={() => {
                setStatusFilter('ALL');
                setSearchQuery('');
              }}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Order ID</TH>
                  <TH>Customer</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Total Amount</TH>
                  <TH>Payment</TH>
                  <TH>Fulfillment Status</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((ord) => (
                  <tr key={ord.id}>
                    <TD className="font-mono text-xs font-medium">#{ord.id.slice(0, 8)}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">
                      {ord.customerId ? ord.customerId.slice(0, 10) : '—'}
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {ord.createdAt ? new Date(ord.createdAt).toLocaleDateString() : '—'}
                    </TD>
                    <TD className="tnum text-right font-medium text-xs">
                      {formatMoney((ord.totalAmount || 0) / 100, ord.currency || displayCurrency)}
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {ord.paymentStatus || 'CAPTURED'}
                    </TD>
                    <TD>
                      <Badge variant={statusVariant(ord.status)}>{ord.status}</Badge>
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
