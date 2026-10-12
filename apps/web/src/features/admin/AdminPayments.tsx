import { useState, useEffect, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { CreditCard, RefreshCw, Search } from 'lucide-react';
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

interface Payment {
  id: string;
  orderId?: string;
  amount: number;
  currency?: string;
  status: string;
  method?: string;
  provider?: string;
  createdAt: string;
}

export const AdminPayments = () => {
  const { user } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const loadPayments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>('/admin/payments');
      const list = Array.isArray(res)
        ? (res as Payment[])
        : ((res as { payments?: Payment[] }).payments ?? []);
      setPayments(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load payments');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadPayments();
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return payments.filter((p) => {
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        (p.orderId && p.orderId.toLowerCase().includes(q)) ||
        (p.method && p.method.toLowerCase().includes(q)) ||
        (p.provider && p.provider.toLowerCase().includes(q))
      );
    });
  }, [payments, searchQuery, statusFilter]);

  const totalVolume = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0) / 100;
  const displayCurrency = payments.find((p) => p.currency)?.currency ?? 'INR';
  const succeededCount = payments.filter(
    (p) => p.status === 'CAPTURED' || p.status === 'SUCCEEDED',
  ).length;
  const pendingCount = payments.filter(
    (p) => p.status === 'PENDING' || p.status === 'PROCESSING',
  ).length;
  const failedCount = payments.filter(
    (p) => p.status === 'FAILED' || p.status === 'REFUNDED',
  ).length;

  const statusVariant = (s: string) => {
    switch (s) {
      case 'CAPTURED':
      case 'SUCCEEDED':
        return 'success' as const;
      case 'PENDING':
      case 'PROCESSING':
        return 'warning' as const;
      case 'FAILED':
      case 'REFUNDED':
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
          <h1 className="text-xl font-semibold tracking-tight">Payment transactions</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Platform payment gateway charges, capture receipts, and refund ledgers.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadPayments} disabled={isLoading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="error" title="Could not load payments">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Gross payments captured</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {formatMoney(totalVolume, displayCurrency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {payments.length} transactions processed
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="All payments" value={String(payments.length)} hint="recorded" />
          <KpiCard label="Succeeded" value={String(succeededCount)} hint="funds captured" />
          <KpiCard
            label="Pending / Processing"
            value={String(pendingCount)}
            hint={failedCount > 0 ? `${failedCount} failed/refunded` : 'in transit'}
          />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Transactions list</CardTitle>
              <CardDescription>
                Filter by payment status or search by intent ID and order ID
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search transaction ID..."
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
                {['ALL', 'CAPTURED', 'SUCCEEDED', 'PENDING', 'FAILED'].map((s) => (
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
              icon={CreditCard}
              title="No transactions found"
              description="No payment records match the filter criteria."
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
                  <TH>Payment Intent ID</TH>
                  <TH>Order ID</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Gateway / Method</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Timestamp</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <TD className="font-mono text-xs font-medium">#{p.id.slice(0, 8)}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">
                      {p.orderId ? `#${p.orderId.slice(0, 8)}` : '—'}
                    </TD>
                    <TD className="tnum text-right font-medium text-xs">
                      {formatMoney((p.amount || 0) / 100, p.currency || displayCurrency)}
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {p.method || p.provider || 'Razorpay / UPI'}
                    </TD>
                    <TD>
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                    </TD>
                    <TD className="text-right text-xs text-muted-foreground">
                      {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
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
