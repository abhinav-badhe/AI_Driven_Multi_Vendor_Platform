import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { Inbox, Truck } from "lucide-react";
import { merchantApi, type SellerOrderDto } from "./api/merchant";
import { Button, buttonVariants } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { formatMoney } from "../../lib/format";

type StatusFilter = "ALL" | SellerOrderDto["status"];

// Matches the backend seller-order state machine
// (PENDING_PAYMENT → PAID → PROCESSING → COMPLETED).
const NEXT_STEP: Record<SellerOrderDto["status"], { to: SellerOrderDto["status"]; label: string } | null> = {
  PENDING_PAYMENT: { to: "PAID", label: "Mark paid" },
  PAID: { to: "PROCESSING", label: "Start processing" },
  PROCESSING: { to: "COMPLETED", label: "Complete order" },
  COMPLETED: null,
  CANCELLED: null,
};

const statusVariant = (s: SellerOrderDto["status"]) =>
  s === "COMPLETED" ? ("success" as const)
  : s === "CANCELLED" ? ("destructive" as const)
  : s === "PENDING_PAYMENT" ? ("warning" as const)
  : ("outline" as const);

export const MerchantOrders = () => {
  const [orders, setOrders] = useState<SellerOrderDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const fetchOrders = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await merchantApi.getSellerOrders();
      setOrders(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load orders.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const filtered = useMemo(
    () => (statusFilter === "ALL" ? orders : orders.filter((o) => o.status === statusFilter)),
    [orders, statusFilter]
  );

  const handleAdvance = async (order: SellerOrderDto) => {
    const next = NEXT_STEP[order.status];
    if (!next) return;
    setUpdatingId(order.id);
    setError(null);
    try {
      await merchantApi.updateOrderStatus(order.id, next.to);
      setNotice(`Order marked as ${next.to.toLowerCase().replace("_", " ")}.`);
      setTimeout(() => setNotice(null), 4000);
      await fetchOrders();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Status update failed.");
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Merchant Orders &amp; Fulfillment ({orders.length})
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Fulfill customer orders assigned to your store.
        </p>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex gap-1" role="group" aria-label="Filter by status">
        {(["ALL", "PENDING_PAYMENT", "PAID", "PROCESSING", "COMPLETED"] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase().replace("_p", " p")}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div aria-label="Loading orders">
          <TableSkeleton rows={4} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No orders currently assigned to your seller account."
          description={
            orders.length === 0
              ? "New customer purchases will appear here for fulfillment."
              : "No orders match this status filter."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((order) => {
            const next = NEXT_STEP[order.status];
            return (
              <Card key={order.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted-foreground">
                        Order {order.id.slice(0, 8)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Placed {new Date(order.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="tnum text-sm font-semibold">
                        {formatMoney(order.totalAmount / 100, order.currency)}
                      </p>
                      <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
                      {(order.status === "PAID" || order.status === "PROCESSING") && (
                        <Link
                          to="/merchant/fulfillment"
                          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
                        >
                          <Truck size={14} /> Fulfill
                        </Link>
                      )}
                      {next && (
                        <Button
                          size="sm"
                          disabled={updatingId === order.id}
                          onClick={() => handleAdvance(order)}
                        >
                          {updatingId === order.id ? "Saving…" : next.label}
                        </Button>
                      )}
                    </div>
                  </div>
                  {order.items && order.items.length > 0 && (
                    <ul className="mt-2 divide-y divide-border">
                      {order.items.map((it) => (
                        <li key={it.id} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
                          <span className="min-w-0 truncate">
                            {it.productName || it.skuCode}{" "}
                            <span className="tnum text-muted-foreground">× {it.quantity}</span>
                          </span>
                          <span className="tnum shrink-0 font-medium">
                            {formatMoney(it.lineTotalAmount / 100, order.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
