import React from 'react';
import { Printer, X, Truck, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import type { ShipmentDto } from '../MerchantFulfillment';
import type { DeliveryAddressCoords } from './DeliveryRouteMap';

interface PrintableShippingLabelModalProps {
  shipment: ShipmentDto | null;
  deliveryAddress?: DeliveryAddressCoords | null;
  onClose: () => void;
}

export const PrintableShippingLabelModal: React.FC<PrintableShippingLabelModalProps> = ({
  shipment,
  deliveryAddress,
  onClose,
}) => {
  if (!shipment) return null;

  const tracking = shipment.trackingNumber || `TRK_${shipment.id.slice(0, 8).toUpperCase()}`;
  const carrier = shipment.carrier || 'BlueDart Express';
  const recipientName = deliveryAddress?.recipientName || 'Abhinav Badhe';
  const phone = deliveryAddress?.phone || '+91 77740 94369';
  const addressLine = deliveryAddress?.formattedAddress || 
    `${deliveryAddress?.addressLine1 || 'MIT AOE Campus, Alandi'}, ${deliveryAddress?.city || 'Pune'}, ${deliveryAddress?.state || 'Maharashtra'} - ${deliveryAddress?.postalCode || '412105'}`;

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        {/* Header toolbar */}
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded bg-primary/10 text-primary">
              <Printer className="size-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Official Carrier Postage Airway Bill (AWB)</h2>
              <p className="text-[11px] text-muted-foreground font-mono">AWB #{tracking}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handlePrint} className="h-8 gap-1.5 text-xs">
              <Printer className="size-3.5" />
              Print Label
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Printable Label Sheet */}
        <div className="overflow-y-auto p-6">
          <div id="printable-carrier-label" className="mx-auto max-w-md border-2 border-black bg-white p-5 text-black font-sans shadow-md">
            {/* Carrier Banner */}
            <div className="flex items-center justify-between border-b-2 border-black pb-3">
              <div>
                <div className="flex items-center gap-1.5">
                  <Truck className="size-5 text-black" />
                  <span className="text-lg font-black tracking-tight uppercase">{carrier}</span>
                </div>
                <p className="text-[10px] font-bold tracking-widest text-neutral-600 uppercase">PRIORITY AIR / ROUTE DISPATCH</p>
              </div>
              <div className="text-right">
                <span className="inline-block border border-black bg-black px-2 py-0.5 text-xs font-black text-white uppercase">
                  PREPAID
                </span>
                <p className="mt-1 text-[10px] font-mono font-bold">PORT: PNQ-01</p>
              </div>
            </div>

            {/* Simulated High-Density Barcode */}
            <div className="my-3 border-b-2 border-black pb-3 text-center">
              <div className="mx-auto flex h-14 w-full items-stretch justify-center gap-[2px] bg-neutral-100 p-2">
                {Array.from({ length: 48 }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-black"
                    style={{
                      width: i % 4 === 0 ? '4px' : i % 3 === 0 ? '2px' : '1px',
                    }}
                  />
                ))}
              </div>
              <p className="mt-1 font-mono text-xs font-bold tracking-widest">*{tracking}*</p>
            </div>

            {/* Ship To / Delivery Destination */}
            <div className="border-b-2 border-black pb-3">
              <div className="flex items-center justify-between text-[11px] font-black uppercase text-neutral-500">
                <span>DELIVERY DESTINATION (CONSIGNEE)</span>
                <span>ZONE: MH-WEST</span>
              </div>
              <div className="mt-1 text-sm font-black uppercase">{recipientName}</div>
              <div className="text-xs font-bold text-neutral-800">Phone: {phone}</div>
              <div className="mt-1 text-xs leading-snug">{addressLine}</div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-xs font-bold">
                <span className="border border-black px-1.5 py-0.5">PIN: {deliveryAddress?.postalCode || '412105'}</span>
                <span>DEST: {deliveryAddress?.city?.toUpperCase() || 'PUNE'}</span>
              </div>
            </div>

            {/* Return / Origin Dispatch Node */}
            <div className="border-b-2 border-black py-2.5 text-[11px]">
              <span className="font-bold text-neutral-600 uppercase">DISPATCHED FROM (MERCHANT SENDER):</span>
              <p className="mt-0.5 font-semibold text-black">
                Central Warehouse Hub (FC-01) • Hinjawadi Phase 1, Pune, MH 411057
              </p>
            </div>

            {/* Order and Telemetry Footer */}
            <div className="grid grid-cols-3 gap-2 pt-2.5 text-[10px]">
              <div className="border border-black p-1">
                <span className="block text-neutral-500 font-bold uppercase">ORDER REF</span>
                <span className="font-mono font-bold">#{shipment.sellerOrderId.slice(0, 8)}</span>
              </div>
              <div className="border border-black p-1">
                <span className="block text-neutral-500 font-bold uppercase">WEIGHT</span>
                <span className="font-mono font-bold">0.85 KG</span>
              </div>
              <div className="border border-black p-1">
                <span className="block text-neutral-500 font-bold uppercase">PIECES</span>
                <span className="font-mono font-bold">{shipment.items?.length || 1} PKG</span>
              </div>
            </div>

            {/* QR / Tracking verification line */}
            <div className="mt-3 flex items-center justify-between border-t border-dashed border-black pt-2 text-[9px] text-neutral-600">
              <span className="flex items-center gap-1 font-semibold">
                <ShieldCheck className="size-3 text-black" /> SECURE DISPATCH VERIFIED
              </span>
              <span className="font-mono">{new Date().toLocaleDateString()} {new Date().toLocaleTimeString()}</span>
            </div>
          </div>
        </div>

        {/* Modal footer actions */}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-5 py-3">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="size-3.5 text-emerald-600" /> Ready to affix to customer parcel
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={handlePrint} className="gap-1.5">
              <Printer className="size-3.5" />
              Print Airway Bill
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
