import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
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
import { EmptyState, TableSkeleton } from '../../components/ui/empty';
import { cn } from '../../lib/utils';

export interface CustomerReturnDto {
  id: string;
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  status:
    'REQUESTED' | 'APPROVED' | 'REJECTED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED';
  items: Array<{ orderItemId: string; quantity: number }>;
  createdAt: string;
}

const statusVariant = (status: CustomerReturnDto['status']) => {
  if (status === 'COMPLETED' || status === 'APPROVED') return 'success' as const;
  if (status === 'REJECTED') return 'destructive' as const;
  return 'outline' as const;
};

export const CustomerReturns = () => {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [returns, setReturns] = useState<CustomerReturnDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReturns = async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<CustomerReturnDto[]>('/fulfillment/returns');
      setReturns(data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load returns');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReturns();
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>Returns</CardTitle>
            <CardDescription>
              Sign in to view return requests, tracking status, and refunds.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2.5">
            <Button
              size="sm"
              onClick={async () => {
                await login({ email: 'customer@example.com', password: 'password123' });
              }}
            >
              Sign in as Demo Customer
            </Button>
            <Link to="/account" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              Sign in with Other Account
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Returns and refunds</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Return authorizations, pickups, and refund credits.
          </p>
        </div>
        <Link to="/orders" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          View all orders
        </Link>
      </div>

      {error && (
        <Alert tone="error" title="Could not load returns">
          {error}
        </Alert>
      )}

      {isLoading ? (
        <div aria-label="Loading returns">
          <TableSkeleton rows={3} />
        </div>
      ) : returns.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No returns in progress"
          description="You have not requested returns on any delivered items. To return a purchased item, start from your order history."
          actionLabel="Go to my orders"
          onAction={() => navigate('/orders')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {returns.map((ret) => (
            <Card key={ret.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs">RMA {ret.id}</p>
                  <Badge variant={statusVariant(ret.status)}>{ret.status}</Badge>
                </div>
                <p className="mt-2 text-[13px]">
                  <span className="text-muted-foreground">Reason: </span>
                  {ret.reason}
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  Order {ret.customerOrderId} · Seller {ret.sellerOrderId}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested {new Date(ret.createdAt).toLocaleString()} · {ret.items?.length || 1}{' '}
                  {(ret.items?.length || 1) === 1 ? 'item' : 'items'}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
