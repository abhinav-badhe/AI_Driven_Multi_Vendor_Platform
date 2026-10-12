import { useState, useEffect } from 'react';
import { Truck, ExternalLink, Printer, Ban, RefreshCw, Search, Compass } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert } from '../../components/ui/alert';
import { EmptyState, Skeleton } from '../../components/ui/empty';
import { Input, Label } from '../../components/ui/input';
import { DeliveryRouteMap, type DeliveryAddressCoords } from './components/DeliveryRouteMap';
import { PrintableShippingLabelModal } from './components/PrintableShippingLabelModal';

export type ShipmentStatus =
  | 'PENDING'
  | 'READY_TO_SHIP'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RETURNED';

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
  metadata?: Record<string, unknown> | null;
}

interface SellerOrderSummary {
  id: string;
  customerOrderId: string;
  status: string;
  totalAmount: number;
  currency: string;
  shippingAddress?: DeliveryAddressCoords | null;
  items?: Array<{ id: string; productName?: string; quantity: number }>;
}

const NEXT_STEP: Partial<Record<ShipmentStatus, { to: ShipmentStatus; label: string }>> = {
  PENDING: { to: 'READY_TO_SHIP', label: 'Mark ready to ship' },
  READY_TO_SHIP: { to: 'SHIPPED', label: 'Dispatch with carrier' },
  SHIPPED: { to: 'IN_TRANSIT', label: 'Mark in transit' },
  IN_TRANSIT: { to: 'OUT_FOR_DELIVERY', label: 'Mark out for delivery' },
  OUT_FOR_DELIVERY: { to: 'DELIVERED', label: 'Confirm delivery' },
};

const statusVariant = (s: ShipmentStatus) =>
  s === 'DELIVERED'
    ? ('success' as const)
    : s === 'CANCELLED' || s === 'FAILED'
      ? ('destructive' as const)
      : s === 'PENDING'
        ? ('warning' as const)
        : ('outline' as const);

const CARRIERS = [
  'BlueDart Express',
  'Delhivery Surface',
  'Shippo Sandbox',
  'FedEx Priority',
  'DHL Express',
];

const STATUS_FILTERS: Array<{ label: string; value: ShipmentStatus | 'ALL' }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Ready to ship', value: 'READY_TO_SHIP' },
  { label: 'Shipped', value: 'SHIPPED' },
  { label: 'In transit', value: 'IN_TRANSIT' },
  { label: 'Delivered', value: 'DELIVERED' },
];

export const MerchantFulfillment = () => {
  const { user } = useAuth();
  const [shipments, setShipments] = useState<ShipmentDto[]>([]);
  const [sellerOrders, setSellerOrders] = useState<SellerOrderSummary[]>([]);
  const [activeShipmentId, setActiveShipmentId] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ShipmentStatus | 'ALL'>('ALL');

  const [showCreate, setShowCreate] = useState(false);
  const [selectedSellerOrderId, setSelectedSellerOrderId] = useState('');
  const [selectedCarrier, setSelectedCarrier] = useState(CARRIERS[0]!);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [labelModalShipment, setLabelModalShipment] = useState<ShipmentDto | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [shipmentsData, ordersData] = await Promise.all([
        apiClient<ShipmentDto[]>('/fulfillment/shipments'),
        apiClient<SellerOrderSummary[]>('/seller/orders').catch(() => [] as SellerOrderSummary[]),
      ]);
      const loadedShipments = Array.isArray(shipmentsData) ? shipmentsData : [];
      setShipments(loadedShipments);
      const loadedOrders = Array.isArray(ordersData) ? ordersData : [];
      setSellerOrders(loadedOrders);

      if (loadedShipments.length > 0 && !activeShipmentId) {
        setActiveShipmentId(loadedShipments[0]!.id);
      } else if (loadedShipments.length === 0) {
        setActiveShipmentId(null);
      }

      if (loadedOrders.length > 0 && !selectedSellerOrderId) {
        setSelectedSellerOrderId(loadedOrders[0]!.id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load fulfillment records.');
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
        method: 'POST',
        body: JSON.stringify({ status: next.to }),
      });
      setNotice(`Shipment marked as ${next.to.toLowerCase().replace(/_/g, ' ')}.`);
      setTimeout(() => setNotice(null), 4000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Status update failed.');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCancel = async (s: ShipmentDto) => {
    if (!confirm('Are you sure you want to cancel this carrier shipment label?')) return;
    setUpdatingId(s.id);
    setError(null);
    try {
      await apiClient<ShipmentDto>(`/fulfillment/shipments/${s.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Merchant cancelled fulfillment' }),
      });
      setNotice(`Shipment #${s.id.slice(0, 8)} cancelled with carrier.`);
      setTimeout(() => setNotice(null), 4000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Cancellation failed.');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCheckTracking = async (s: ShipmentDto) => {
    setUpdatingId(s.id);
    setError(null);
    try {
      const telemetry = await apiClient<{
        carrier: string;
        trackingNumber: string;
        status: string;
        location?: string;
      }>(`/fulfillment/shipments/${s.id}/tracking`);
      setNotice(
        `Carrier telemetry: ${telemetry.status} ${telemetry.location ? `(${telemetry.location})` : ''}`,
      );
      setTimeout(() => setNotice(null), 5000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not fetch carrier telemetry.');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleCreateShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSellerOrderId.trim()) {
      setError('Please select or enter a seller order to fulfill.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const order = sellerOrders.find((o) => o.id === selectedSellerOrderId.trim());
      let itemsToFulfill =
        order?.items && order.items.length > 0
          ? order.items.map((it) => ({ orderItemId: it.id, quantity: it.quantity }))
          : [];

      if (itemsToFulfill.length === 0 && selectedSellerOrderId.trim()) {
        try {
          const detail = await apiClient<{ items?: Array<{ id: string; quantity: number }> }>(
            `/seller/orders/${selectedSellerOrderId.trim()}`,
          );
          if (detail?.items && detail.items.length > 0) {
            itemsToFulfill = detail.items.map((it) => ({
              orderItemId: it.id,
              quantity: it.quantity,
            }));
          }
        } catch {
          // fall through
        }
      }

      if (itemsToFulfill.length === 0) {
        setError('Could not identify items for this order. Please verify order details.');
        return;
      }

      const newShipment = await apiClient<ShipmentDto>('/fulfillment/shipments', {
        method: 'POST',
        body: JSON.stringify({
          sellerOrderId: selectedSellerOrderId.trim(),
          carrier: selectedCarrier.trim(),
          items: itemsToFulfill,
          idempotencyKey: `m_ship_${selectedSellerOrderId.trim()}_${Date.now()}`,
        }),
      });

      setShowCreate(false);
      setActiveShipmentId(newShipment.id);
      setLabelModalShipment(newShipment);
      setNotice(
        `Carrier shipment created successfully! Tracking: ${newShipment.trackingNumber || 'Assigned'}. Airway bill generated.`,
      );
      setTimeout(() => setNotice(null), 5000);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not register shipment with carrier.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredShipments = shipments.filter((s) => {
    if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchId = s.id.toLowerCase().includes(q);
      const matchOrder = s.sellerOrderId.toLowerCase().includes(q);
      const matchCarrier = (s.carrier || '').toLowerCase().includes(q);
      const matchTrack = (s.trackingNumber || '').toLowerCase().includes(q);
      if (!matchId && !matchOrder && !matchCarrier && !matchTrack) return false;
    }
    return true;
  });

  // Active shipment object for map view
  const activeShipment = shipments.find((s) => s.id === activeShipmentId) || shipments[0] || null;

  // Selected order for pending route inspection
  const selectedOrder =
    sellerOrders.find((o) => o.id === selectedSellerOrderId.trim()) || sellerOrders[0] || null;

  // Resolve matching seller order to obtain delivery address details
  const matchingOrder = activeShipment
    ? sellerOrders.find(
        (o) =>
          o.id === activeShipment.sellerOrderId ||
          o.customerOrderId === activeShipment.customerOrderId,
      )
    : selectedOrder;

  const activeDeliveryAddress: DeliveryAddressCoords = (activeShipment?.metadata?.[
    'deliveryAddress'
  ] as DeliveryAddressCoords) ||
    matchingOrder?.shippingAddress || {
      recipientName: 'Abhinav Badhe',
      phone: '+91 77740 94369',
      addressLine1: 'MIT AOE Campus, Alandi',
      addressLine2: 'Dighi Road',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '412105',
      country: 'IN',
      latitude: 18.6755,
      longitude: 73.8967,
      formattedAddress: 'Alandi, Pune, Maharashtra 412105, India',
    };

  return (
    <div className="space-y-5 p-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Carrier Fulfillment & Route Logistics
            </h1>
            <Badge variant="outline" className="font-mono text-xs">
              {shipments.length} Active
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Visualize customer delivery pinpoints with coordinates, calculate transit routes, and
            track live carrier fulfillment.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw className="size-3.5 mr-1" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Truck className="size-3.5 mr-1" />
            Fulfill seller order
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {/* 1. Map & Route Visualization Section */}
      {activeShipment ? (
        <section aria-label="Route and Delivery Map">
          <DeliveryRouteMap
            shipmentId={activeShipment.id}
            trackingNumber={activeShipment.trackingNumber || undefined}
            carrier={activeShipment.carrier || 'BlueDart Express'}
            status={activeShipment.status}
            deliveryAddress={activeDeliveryAddress}
            onAdvanceStatus={() => handleAdvance(activeShipment)}
            isUpdating={updatingId === activeShipment.id}
          />
        </section>
      ) : selectedOrder ? (
        <section aria-label="Route and Delivery Map">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs font-mono">
                Route Preview • Order #{selectedOrder.id.slice(0, 8)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Customer delivery destination coordinates pinned below
              </span>
            </div>
            {!showCreate && (
              <Button size="sm" onClick={() => setShowCreate(true)} className="h-7 text-xs">
                <Truck className="size-3.5 mr-1" />
                Dispatch Order with {selectedCarrier}
              </Button>
            )}
          </div>
          <DeliveryRouteMap
            shipmentId={undefined}
            trackingNumber={undefined}
            carrier={selectedCarrier}
            status="READY_TO_SHIP"
            deliveryAddress={activeDeliveryAddress}
          />
        </section>
      ) : (
        <Card className="border border-dashed border-border bg-muted/20 p-6 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Compass className="size-6" />
          </div>
          <h3 className="mt-3 text-sm font-semibold">No Incoming Orders to Fulfill</h3>
          <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
            All customer orders are currently fulfilled or awaiting checkout payments.
          </p>
        </Card>
      )}

      {/* 2. Create Shipment Modal / Drawer */}
      {showCreate && (
        <Card className="border border-primary/30 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  Initiate Carrier Label & Route Dispatch
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Purchases carrier postage label and pins the customer delivery coordinates onto
                  the fulfillment map.
                </p>
              </div>
            </div>

            <form onSubmit={handleCreateShipment} className="mt-4 flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="seller-order-id">Select Seller Order</Label>
                  {sellerOrders.length > 0 ? (
                    <select
                      id="seller-order-id"
                      value={selectedSellerOrderId}
                      onChange={(e) => setSelectedSellerOrderId(e.target.value)}
                      className="h-9 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:border-ring"
                    >
                      {sellerOrders.map((o) => (
                        <option key={o.id} value={o.id}>
                          Order #{o.id.slice(0, 8)} • Total: {o.currency} {o.totalAmount} (
                          {o.status})
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
                  <Label htmlFor="carrier-select">Carrier Fleet Partner</Label>
                  <select
                    id="carrier-select"
                    value={selectedCarrier}
                    onChange={(e) => setSelectedCarrier(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:border-ring"
                  >
                    {CARRIERS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Order Items Preview */}
              {selectedOrder?.items && selectedOrder.items.length > 0 && (
                <div className="rounded-md border border-border/80 bg-background/80 p-2.5 text-xs">
                  <span className="font-semibold text-muted-foreground block mb-1">
                    Order items included for carrier fulfillment:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {selectedOrder.items.map((it) => (
                      <span
                        key={it.id}
                        className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground"
                      >
                        {it.productName || 'Product'} × {it.quantity}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
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
                  {isSubmitting ? 'Generating Label…' : 'Purchase label & calculate route'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* 3. Search and Status Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by shipment ID, order, carrier, or tracking…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s.value}
              variant={statusFilter === s.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s.value)}
              className="text-xs"
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      {/* 4. Shipment Cards Grid */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading shipments">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      ) : filteredShipments.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={shipments.length === 0 ? 'No active shipments' : 'No matching shipments'}
          description={
            shipments.length === 0
              ? 'Purchased orders ready for fulfillment will appear here once processed.'
              : 'Try clearing search or changing the status filter.'
          }
        />
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {filteredShipments.map((s) => {
            const next = NEXT_STEP[s.status];
            const canCancel = s.status === 'PENDING' || s.status === 'READY_TO_SHIP';
            const isSelected = activeShipmentId === s.id;

            return (
              <Card
                key={s.id}
                className={`transition-all cursor-pointer ${
                  isSelected
                    ? 'border-primary ring-1 ring-primary shadow-sm bg-primary/[0.02]'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
                onClick={() => setActiveShipmentId(s.id)}
              >
                <CardContent className="flex flex-col gap-2.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm text-foreground">
                          Shipment #{s.id.slice(0, 8)}
                        </span>
                        {isSelected && (
                          <Badge variant="default" className="text-[10px] py-0 px-1.5 h-4">
                            Active on Map
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span>Order #{s.sellerOrderId.slice(0, 8)}</span>
                        <span>•</span>
                        <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <Badge variant={statusVariant(s.status)} className="text-[11px]">
                      {s.status.replace(/_/g, ' ')}
                    </Badge>
                  </div>

                  {/* Telemetry and Carrier summary */}
                  <div className="rounded-md border border-border/80 bg-muted/30 p-2.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Carrier Fleet:</span>
                      <span className="font-medium text-foreground">
                        {s.carrier || 'BlueDart Express'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Tracking ID:</span>
                      <span className="font-mono font-medium text-foreground">
                        {s.trackingNumber || 'Pending'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Destination:</span>
                      <span className="font-medium text-foreground truncate max-w-[170px]">
                        {activeDeliveryAddress.city || 'Pune'},{' '}
                        {activeDeliveryAddress.state || 'MH'}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 border-t border-border/50 pt-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLabelModalShipment(s);
                        }}
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      >
                        <Printer size={12} /> Airway Bill (AWB)
                      </button>
                      {s.labelUrl && !s.labelUrl.includes('mocklogistics') && (
                        <a
                          href={s.labelUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={12} /> Carrier PDF
                        </a>
                      )}
                      {s.trackingUrl && (
                        <a
                          href={s.trackingUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={12} /> Portal
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Action footer */}
                  <div
                    className="mt-auto flex items-center justify-end gap-1.5 border-t border-border pt-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={updatingId === s.id}
                      onClick={() => handleCheckTracking(s)}
                      className="text-xs h-7 px-2"
                    >
                      <RefreshCw
                        size={11}
                        className={`mr-1 ${updatingId === s.id ? 'animate-spin' : ''}`}
                      />
                      Telemetry
                    </Button>

                    {next && (
                      <Button
                        size="sm"
                        disabled={updatingId === s.id}
                        onClick={() => handleAdvance(s)}
                        className="text-xs h-7 px-2"
                      >
                        {updatingId === s.id ? 'Updating…' : next.label}
                      </Button>
                    )}

                    {canCancel && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={updatingId === s.id}
                        onClick={() => handleCancel(s)}
                        className="text-xs h-7 px-2"
                      >
                        <Ban size={11} className="mr-1" />
                        Cancel
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Printable Shipping Airway Bill Modal */}
      {labelModalShipment && (
        <PrintableShippingLabelModal
          shipment={labelModalShipment}
          deliveryAddress={activeDeliveryAddress}
          onClose={() => setLabelModalShipment(null)}
        />
      )}
    </div>
  );
};
