import { useState, useEffect, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { Users, RefreshCw, Search } from 'lucide-react';
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
import { cn } from '../../lib/utils';

interface UserRecord {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  createdAt: string;
}

export const AdminUsers = () => {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');

  const loadUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient<unknown>('/admin/users').catch(() =>
        apiClient<unknown>('/users'),
      );
      const list = Array.isArray(res)
        ? (res as UserRecord[])
        : ((res as { users?: UserRecord[] }).users ?? []);
      setUsers(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMINISTRATOR') return;
    loadUsers();
  }, [user]);

  if (user?.role !== 'ADMINISTRATOR') return <Navigate to="/account" replace />;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        u.tenantId.toLowerCase().includes(q)
      );
    });
  }, [users, searchQuery, roleFilter]);

  const customerCount = users.filter((u) => u.role === 'CUSTOMER').length;
  const merchantCount = users.filter((u) => u.role === 'MERCHANT').length;
  const adminCount = users.filter((u) => u.role === 'ADMINISTRATOR').length;

  const roleVariant = (role: string) => {
    switch (role) {
      case 'ADMINISTRATOR':
        return 'destructive' as const;
      case 'MERCHANT':
        return 'warning' as const;
      default:
        return 'outline' as const;
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">User accounts</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Platform identity directory, customer shoppers, merchants, and system administrators.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadUsers} disabled={isLoading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="error" title="Could not load users">
          {error}
        </Alert>
      )}

      {/* Bento KPIs matching Merchant Panel */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total registered accounts</p>
            <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
              {users.length} accounts
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Unified identity credentials across all tenant boundaries
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
          <KpiCard label="Customers" value={String(customerCount)} hint="storefront shoppers" />
          <KpiCard label="Merchants" value={String(merchantCount)} hint="seller store owners" />
          <KpiCard label="Administrators" value={String(adminCount)} hint="superadmin operators" />
        </div>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Accounts directory</CardTitle>
              <CardDescription>Search by email, account ID, or tenant ID</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search email or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                {['ALL', 'CUSTOMER', 'MERCHANT', 'ADMINISTRATOR'].map((r) => (
                  <option key={r} value={r}>
                    {r === 'ALL' ? 'All roles' : r}
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
              icon={Users}
              title="No users found"
              description="No user accounts match the specified search or filter criteria."
              actionLabel={roleFilter !== 'ALL' || searchQuery ? 'Clear filters' : undefined}
              onAction={() => {
                setRoleFilter('ALL');
                setSearchQuery('');
              }}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Email Address</TH>
                  <TH>User ID</TH>
                  <TH>Tenant ID</TH>
                  <TH>Assigned Role</TH>
                  <TH className="text-right">Created</TH>
                </tr>
              </THead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id}>
                    <TD className="font-medium text-xs">{u.email}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">{u.id.slice(0, 10)}</TD>
                    <TD className="font-mono text-xs text-muted-foreground">{u.tenantId}</TD>
                    <TD>
                      <Badge variant={roleVariant(u.role)}>{u.role}</Badge>
                    </TD>
                    <TD className="text-right text-xs text-muted-foreground">
                      {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
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
