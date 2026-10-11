import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { PackageSearch, RotateCcw, Truck } from "lucide-react";
import { apiClient } from "../../api/client";
import { ordersApi, type CustomerOrderDto, type OrderItemDto } from "./api/orders";
import { returnsApi, type ReturnDto } from "./api/returns";
import { useAuth } from "../auth/AuthContext";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { Input, Label } from "../../components/ui/input";
import { formatPrice } from "../../lib/format";
import { cn } from "../../lib/utils";

export interface CustomerShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  status: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}

export const CustomerOrders = () => {
  const { isAuthenticated, login } = useAuth();
  const [orders, setOrders] = useState<CustomerOrderDto[]>([]);
  const [returns, setReturns] = useState<ReturnDto[]>([]);
  const [shipments, setShipments] = useState<CustomerShipmentDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeReturnItem, setActiveReturnItem] = useState<{
    customerOrderId: string;
    sellerOrderId: string;
    item: OrderItemDto;
  } | null>(null);
  const [returnReason, setReturnReason] = useState("Defective or not working properly");
  const [returnQty, setReturnQty] = useState(1);
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
  const [returnSuccessMsg, setReturnSuccessMsg] = useState<string | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [ordersData, returnsData] = await Promise.all([
        ordersApi.listOrders(),
        returnsApi.listReturns().catch(() => [] as ReturnDto[]),
      ]);
      setOrders(ordersData);
      setReturns(returnsData);

      // Concurrently query fulfillment shipments for all retrieved customer orders
      const shipmentPromises = ordersData.map((o) =>
        apiClient<CustomerShipmentDto[]>(`/fulfillment/shipments?customerOrderId=${o.id}`).catch(
          () => [] as CustomerShipmentDto[],
        ),
      );
      const nestedShipments = await Promise.all(shipmentPromises);
      setShipments(nestedShipments.flat());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    loadData();
  }, [isAuthenticated]);

  const handleReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReturnItem) return;

    setIsSubmittingReturn(true);
    setError(null);

    try {
      await returnsApi.createReturn({
        customerOrderId: activeReturnItem.customerOrderId,
        sellerOrderId: activeReturnItem.sellerOrderId,
        reason: returnReason,
        items: [
          {
            orderItemId: activeReturnItem.item.id,
            skuId: activeReturnItem.item.skuId,
            quantity: returnQty,
            reason: returnReason,
          },
        ],
      });

      setReturnSuccessMsg(`Return requested for ${activeReturnItem.item.productName || "item"}.`);
      setActiveReturnItem(null);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit return request.");
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Card>
          <CardHeader>
            <CardTitle>My Orders</CardTitle>
            <CardDescription>
              Please log in to review your order history, delivery tracking, and seller fulfillments.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2.5">
            <Button
              size="sm"
              onClick={async () => {
                await login({ email: "customer@example.com", password: "password123" });
              }}
            >
              Sign in as Demo Customer
            </Button>
            <Link to="/account" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Sign in with Other Account
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 p-4" aria-label="Loading orders">
        <TableSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My Orders ({orders.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Order history with per-seller fulfillment status.
          </p>
        </div>
        <Link to="/search" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          Continue shopping
        </Link>
      </div>

      {returnSuccessMsg && (
        <Alert tone="success" title="Return requested">
          {returnSuccessMsg}
        </Alert>
      )}

      {error && (
        <Alert tone="error" title="Could not load orders">
          {error}
        </Alert>
      )}

      {orders.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="No orders placed yet"
          description="When you complete a purchase, your order history and seller tracking will appear here."
          actionLabel="Browse products"
          onAction={() => undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((order) => {
            const orderReturns = returns.filter((r) => r.customerOrderId === order.id);

            return (
              <Card key={order.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                    <div>
                      <p className="text-sm font-semibold">Order #{order.orderNumber}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>
                          Placed {new Date(order.createdAt).toLocaleDateString(undefined, { dateStyle: "long" })}
                        </span>
                        {order.paymentMethod === "COD" && (
                          <Badge variant="outline">Cash on delivery</Badge>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="tnum text-sm font-semibold">
                        {formatPrice(order.totalAmount, order.currency, 2)}
                      </p>
                      <Badge variant="success">{order.status}</Badge>
                    </div>
                  </div>

                  {orderReturns.length > 0 && (
                    <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                      <p className="text-[13px] font-medium">Returns on this order</p>
                      {orderReturns.map((ret) => (
                        <p key={ret.id} className="mt-0.5 flex justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">{ret.id.slice(0, 8)} · {ret.reason}</span>
                          <span>{ret.status}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  {order.sellerOrders && order.sellerOrders.length > 0 && (
                    <div className="mt-3 flex flex-col gap-2">
                      {order.sellerOrders.map((sellerOrder) => (
                        <div key={sellerOrder.id} className="rounded-md bg-muted px-3 py-2">
                          <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                            <span className="font-mono text-xs text-muted-foreground">
                              {sellerOrder.sellerTenantId}
                            </span>
                            <Badge variant="outline">{sellerOrder.status}</Badge>
                          </div>
                          {sellerOrder.items && sellerOrder.items.length > 0 && (
                            <ul className="mt-1 divide-y divide-border">
                              {sellerOrder.items.map((item) => (
                                <li key={item.id} className="flex items-center gap-2 py-2">
                                  {item.productThumbnailUrl ? (
                                    <img
                                      src={item.productThumbnailUrl}
                                      alt=""
                                      loading="lazy"
                                      className="size-9 shrink-0 rounded border border-border object-cover"
                                    />
                                  ) : (
                                    <span className="size-9 shrink-0 rounded border border-border bg-muted" aria-hidden />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] font-medium">
                                      {item.productName || item.skuCode}
                                    </p>
                                    <p className="tnum text-xs text-muted-foreground">
                                      Qty {item.quantity} · {formatPrice(item.unitPriceAmount, item.currency, 2)} each
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <span className="tnum text-[13px] font-semibold">
                                      {formatPrice(item.lineTotalAmount, item.currency, 2)}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setActiveReturnItem({
                                          customerOrderId: order.id,
                                          sellerOrderId: sellerOrder.id,
                                          item,
                                        });
                                        setReturnQty(item.quantity);
                                        setReturnReason("Defective or not working properly");
                                      }}
                                    >
                                      <RotateCcw aria-hidden />
                                      Return
                                    </Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          {shipments
                            .filter((s) => s.sellerOrderId === sellerOrder.id)
                            .map((shipment) => (
                              <div
                                key={shipment.id}
                                className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-background p-2 text-xs"
                              >
                                <div className="flex items-center gap-2">
                                  <Truck size={14} className="text-primary" />
                                  <span>
                                    <strong className="text-foreground">{shipment.carrier || "Carrier"}</strong>:{" "}
                                    {shipment.trackingNumber || "Assigned"}
                                  </span>
                                  <Badge
                                    variant={
                                      shipment.status === "DELIVERED"
                                        ? "success"
                                        : shipment.status === "CANCELLED"
                                          ? "destructive"
                                          : "outline"
                                    }
                                  >
                                    {shipment.status.replace(/_/g, " ")}
                                  </Badge>
                                </div>
                                <Link
                                  to={`/fulfillment/${shipment.id}`}
                                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                                >
                                  Track package &rarr;
                                </Link>
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {activeReturnItem && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setActiveReturnItem(null)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Request return"
            className="relative w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-md"
          >
            <h2 className="text-sm font-semibold">Request return</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {activeReturnItem.item.productName || activeReturnItem.item.skuCode}
            </p>
            <form onSubmit={handleReturnSubmit} className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="return-reason">Reason</Label>
                <select
                  id="return-reason"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                >
                  <option value="Defective or not working properly">Defective or not working properly</option>
                  <option value="Damaged in transit">Damaged in transit</option>
                  <option value="Incorrect item or variant delivered">Incorrect item or variant delivered</option>
                  <option value="Changed mind / No longer needed">Changed mind / No longer needed</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="return-qty">Quantity (max {activeReturnItem.item.quantity})</Label>
                <Input
                  id="return-qty"
                  type="number"
                  min={1}
                  max={activeReturnItem.item.quantity}
                  value={returnQty}
                  onChange={(e) =>
                    setReturnQty(Math.max(1, Math.min(activeReturnItem.item.quantity, Number(e.target.value))))
                  }
                />
              </div>
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmittingReturn}
                  onClick={() => setActiveReturnItem(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isSubmittingReturn}>
                  {isSubmittingReturn ? "Submitting…" : "Confirm return"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
