import { useState, useEffect } from "react";
import { Truck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Alert } from "../../components/ui/alert";
import { EmptyState, TableSkeleton } from "../../components/ui/empty";
import { Input, Label } from "../../components/ui/input";

export interface ShipmentItemDto {
  orderItemId: string;
  quantity: number;
}

export interface ShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  status: "PREPARING" | "PACKED" | "SHIPPED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED";
  items: ShipmentItemDto[];
  dispatchedAt?: string;
  deliveredAt?: string;
  createdAt: string;
}

const NEXT_STEP: Partial<Record<ShipmentDto["status"], { to: ShipmentDto["status"]; label: string }>> = {
  PREPARING: { to: "PACKED", label: "Mark packed" },
  PACKED: { to: "SHIPPED", label: "Dispatch" },
  SHIPPED: { to: "DELIVERED", label: "Confirm delivery" },
  IN_TRANSIT: { to: "OUT_FOR_DELIVERY", label: "Mark out for delivery" },
  OUT_FOR_DELIVERY: { to: "DELIVERED", label: "Confirm delivery" },
};

const statusVariant = (s: ShipmentDto["status"]) =>
  s === "DELIVERED" ? ("success" as const)
  : s === "FAILED" ? ("destructive" as const)
  : s === "PREPARING" ? ("warning" as const)
  : ("outline" as const);

const CARRIERS = ["BlueDart Express", "Delhivery Surface", "FedEx Express", "Shadowfax Local"];

export const MerchantFulfillment = () => {
  const { user } = useAuth();
  const [shipments, setShipments] = useState<ShipmentDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newSellerOrderId, setNewSellerOrderId] = useState("");
  const [newCarrier, setNewCarrier] = useState(CARRIERS[0]!);
  const [newTrackingNumber, setNewTrackingNumber] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadShipments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient<ShipmentDto[]>("/fulfillment/shipments");
      setShipments(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load shipments.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadShipments();
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
      await loadShipments();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Status update failed.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCreateShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSellerOrderId.trim() || !newTrackingNumber.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await apiClient<ShipmentDto>("/fulfillment/shipments", {
        method: "POST",
        body: JSON.stringify({
          sellerOrderId: newSellerOrderId.trim(),
          carrier: newCarrier.trim(),
          trackingNumber: newTrackingNumber.trim(),
          items: [{ orderItemId: "item-default-1", quantity: 1 }],
        }),
      });
      setShowCreate(false);
      setNewSellerOrderId("");
      setNewTrackingNumber("");
      setNotice("Shipment registered with carrier.");
      setTimeout(() => setNotice(null), 4000);
      await loadShipments();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not register shipment.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Fulfillment ({shipments.length})</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Pack, dispatch, and track seller shipments.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={loadShipments}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            Register shipment
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {isLoading ? (
        <div aria-label="Loading shipments">
          <TableSkeleton rows={4} />
        </div>
      ) : shipments.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No shipments yet"
          description="When orders arrive, register them here for carrier pickup and tracking."
          actionLabel="Register shipment"
          onAction={() => setShowCreate(true)}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {shipments.map((s) => {
            const next = NEXT_STEP[s.status];
            return (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-xs">Shipment {s.id.slice(0, 8)}</p>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </div>
                    <p className="mt-1 text-[13px]">
                      {s.carrier || "Standard courier"}
                      {s.trackingNumber && (
                        <span className="font-mono text-xs text-muted-foreground"> · {s.trackingNumber}</span>
                      )}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      Order {s.sellerOrderId} · {s.items?.length || 1}{" "}
                      {(s.items?.length || 1) === 1 ? "item" : "items"}
                    </p>
                  </div>
                  {next && (
                    <Button
                      size="sm"
                      disabled={updatingId === s.id}
                      onClick={() => handleAdvance(s)}
                      className="ml-auto shrink-0"
                    >
                      {updatingId === s.id ? "Saving…" : next.label}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCreate(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Register shipment"
            className="relative w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-md"
          >
            <h2 className="text-sm font-semibold">Register shipment</h2>
            <form onSubmit={handleCreateShipment} className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="ship-order">Seller order ID</Label>
                <Input
                  id="ship-order"
                  required
                  placeholder="Seller order ID"
                  value={newSellerOrderId}
                  onChange={(e) => setNewSellerOrderId(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ship-carrier">Carrier</Label>
                <select
                  id="ship-carrier"
                  value={newCarrier}
                  onChange={(e) => setNewCarrier(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring"
                >
                  {CARRIERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ship-awb">Tracking number (AWB)</Label>
                <Input
                  id="ship-awb"
                  required
                  placeholder="e.g. AWB-982348271"
                  value={newTrackingNumber}
                  onChange={(e) => setNewTrackingNumber(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex justify-end gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isSubmitting}>
                  {isSubmitting ? "Registering…" : "Save shipment"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
