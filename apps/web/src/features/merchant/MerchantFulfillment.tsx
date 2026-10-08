import { useState, useEffect } from "react";
import { Truck, ExternalLink, Printer, Ban, RefreshCw } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { Input, Label } from "../../components/ui/input";

export type ShipmentStatus =
  | "PENDING"
  | "READY_TO_SHIP"
  | "SHIPPED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "FAILED"
  | "RETURNED";

export interface ShipmentItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrierShipmentId?: string | null;
  labelUrl?: string | null;
  status: ShipmentStatus;
  items: ShipmentItemDto[];
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
}

interface SellerOrderSummary {
  id: string;
  status: string;
  totalAmount: number;
  currency: string;
  items?: Array<{ id: string; productName?: string; quantity: number }>;
}

const NEXT_STEP: Partial<Record<ShipmentStatus, { to: ShipmentStatus; label: string }>> = {
  PENDING: { to: "READY_TO_SHIP", label: "Mark ready to ship" },
  READY_TO_SHIP: { to: "SHIPPED", label: "Mark dispatched" },
  SHIPPED: { to: "IN_TRANSIT", label: "Mark in transit" },
  IN_TRANSIT: { to: "OUT_FOR_DELIVERY", label: "Mark out for delivery" },
  OUT_FOR_DELIVERY: { to: "DELIVERED", label: "Confirm delivery" },
};

const statusVariant = (s: ShipmentStatus) =>
  s === "DELIVERED"
    ? ("success" as const)
    : s === "CANCELLED" || s === "FAILED"
      ? ("destructive" as const)
      : s === "PENDING"
        ? ("warning" as const)
        : ("outline" as const);

const CARRIERS = [
  "Shippo Sandbox",
  "USPS Priority Mail",
  "FedEx Ground",
  "UPS Next Day Air",
  "DHL Express",
];

export const MerchantFulfillment = () => {
  const { user } = useAuth();
  const [shipments, setShipments] = useState<ShipmentDto[]>([]);
  const [sellerOrders, setSellerOrders] = useState<SellerOrderSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [selectedSellerOrderId, setSelectedSellerOrderId] = useState("");
  const [selectedCarrier, setSelectedCarrier] = useState(CARRIERS[0]!);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [shipmentsData, ordersData] = await Promise.all([
        apiClient<ShipmentDto[]>("/fulfillment/shipments"),
        apiClient<SellerOrderSummary[]>("/seller/orders").catch(() => [] as SellerOrderSummary[]),
      ]);
      setShipments(Array.isArray(shipmentsData) ? shipmentsData : []);
      setSellerOrders(Array.isArray(ordersData) ? ordersData : []);
      if (ordersData.length > 0 && !selectedSellerOrderId) {
        setSelectedSellerOrderId(ordersData[0]!.id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load fulfillment records.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  const handleAdvance = async (s: ShipmentDto) => {
    const next = NEXT_STEP[s.status];
    if (!next) return;
    setUpdatingId(s.id);
    setError(null);
    try {
      await apiClient<ShipmentDto>(`/fulfillment/shipments/${s.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next.to }),
      });
      setNotice(`Shipment marked as ${next.to.toLowerCase().replace(/_/g, " ")}.`);
      setTimeout(() => setNotice(null), 4000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Status update failed.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCancel = async (s: ShipmentDto) => {
    if (!confirm("Are you sure you want to cancel this carrier shipment label?")) return;
    setUpdatingId(s.id);
    setError(null);
    try {
      await apiClient<ShipmentDto>(`/fulfillment/shipments/${s.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Merchant cancelled fulfillment" }),
      });
      setNotice(`Shipment #${s.id.slice(0, 8)} cancelled with carrier.`);
      setTimeout(() => setNotice(null), 4000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Cancellation failed.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCheckTracking = async (s: ShipmentDto) => {
    setUpdatingId(s.id);
    setError(null);
    try {
      const telemetry = await apiClient<{ carrier: string; trackingNumber: string; status: string; location?: string }>(
        `/fulfillment/shipments/${s.id}/tracking`,
      );
      setNotice(`Carrier telemetry: ${telemetry.status} ${telemetry.location ? `(${telemetry.location})` : ""}`);
      setTimeout(() => setNotice(null), 5000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not fetch carrier telemetry.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCreateShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSellerOrderId.trim()) {
      setError("Please select or enter a seller order to fulfill.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Find order items if available
      const order = sellerOrders.find((o) => o.id === selectedSellerOrderId.trim());
      const itemsToFulfill =
        order?.items && order.items.length > 0
          ? order.items.map((it) => ({ orderItemId: it.id, quantity: it.quantity }))
          : [{ orderItemId: "item-default-1", quantity: 1 }];

      const newShipment = await apiClient<ShipmentDto>("/fulfillment/shipments", {
        method: "POST",
        body: JSON.stringify({
          sellerOrderId: selectedSellerOrderId.trim(),
          carrier: selectedCarrier.trim(),
          items: itemsToFulfill,
          idempotencyKey: `m_ship_${selectedSellerOrderId.trim()}_${Date.now()}`,
        }),
      });

      setShowCreate(false);
      setNotice(
        `Carrier shipment created successfully! Tracking: ${newShipment.trackingNumber || "Assigned"}`,
      );
      setTimeout(() => setNotice(null), 5000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not register shipment with carrier.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Carrier Fulfillment ({shipments.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Generate carrier labels, dispatch packages, and track live deliveries.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={loadData}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            Fulfill seller order
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {showCreate && (
        <Card className="border-brand/40 bg-accent/5">
          <CardContent className="p-4">
            <h2 className="text-sm font-semibold">Start Carrier Fulfillment</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Purchases postage label and allocates authoritative tracking from the carrier gateway.
            </p>
            <form onSubmit={handleCreateShipment} className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="seller-order-id">Seller Order</Label>
                  {sellerOrders.length > 0 ? (
                    <select
                      id="seller-order-id"
                      value={selectedSellerOrderId}
                      onChange={(e) => setSelectedSellerOrderId(e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                    >
                      {sellerOrders.map((o) => (
                        <option key={o.id} value={o.id}>
                          Order {o.id.slice(0, 8)} ({o.status})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id="seller-order-id"
                      placeholder="e.g. so-8a1f2b3c"
                      value={selectedSellerOrderId}
                      onChange={(e) => setSelectedSellerOrderId(e.target.value)}
                      required
                    />
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <Label htmlFor="carrier-select">Carrier Gateway</Label>
                  <select
                    id="carrier-select"
                    value={selectedCarrier}
                    onChange={(e) => setSelectedCarrier(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                  >
                    {CARRIERS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCreate(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isSubmitting}>
                  {isSubmitting ? "Generating Label…" : "Purchase label & dispatch"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div aria-label="Loading shipments">
          <TableSkeleton rows={4} />
        </div>
      ) : shipments.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No active shipments"
          description="Purchased orders ready for fulfillment will appear here once processed."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {shipments.map((s) => {
            const next = NEXT_STEP[s.status];
            const canCancel = s.status === "PENDING" || s.status === "READY_TO_SHIP";

            return (
              <Card key={s.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold">
                          Shipment #{s.id.slice(0, 8)}
                        </span>
                        <Badge variant={statusVariant(s.status)}>
                          {s.status.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Order #{s.sellerOrderId.slice(0, 8)} · Created {new Date(s.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={updatingId === s.id}
                        onClick={() => handleCheckTracking(s)}
                      >
                        <RefreshCw size={12} className={updatingId === s.id ? "animate-spin" : ""} />
                        Telemetry
                      </Button>

                      {next && (
                        <Button
                          size="sm"
                          disabled={updatingId === s.id}
                          onClick={() => handleAdvance(s)}
                        >
                          {updatingId === s.id ? "Updating…" : next.label}
                        </Button>
                      )}

                      {canCancel && (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={updatingId === s.id}
                          onClick={() => handleCancel(s)}
                        >
                          <Ban size={12} />
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Telemetry and Carrier summary */}
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded border border-border bg-muted/40 p-2">
                      <span className="text-muted-foreground">Carrier Partner:</span>
                      <p className="font-medium text-foreground">{s.carrier || "Standard Carrier"}</p>
                    </div>

                    <div className="rounded border border-border bg-muted/40 p-2">
                      <span className="text-muted-foreground">Tracking Number:</span>
                      <p className="font-mono font-medium text-foreground">
                        {s.trackingNumber || "Pending assignment"}
                      </p>
                    </div>

                    <div className="rounded border border-border bg-muted/40 p-2">
                      <span className="text-muted-foreground">Carrier Documents:</span>
                      <div className="mt-0.5 flex gap-2">
                        {s.labelUrl ? (
                          <a
                            href={s.labelUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-primary underline"
                          >
                            <Printer size={12} /> Print label
                          </a>
                        ) : (
                          <span className="text-muted-foreground">No label URL</span>
                        )}
                        {s.trackingUrl && (
                          <a
                            href={s.trackingUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-primary underline"
                          >
                            <ExternalLink size={12} /> Track
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
