import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

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

export interface CarrierAddress {
  name: string;
  street1: string;
  street2?: string | undefined;
  city: string;
  state?: string | undefined;
  postalCode: string;
  country: string;
  phone?: string | undefined;
  email?: string | undefined;
}

export interface CarrierParcel {
  weight: number; // in grams or oz
  length?: number;
  width?: number;
  height?: number;
  massUnit?: 'g' | 'oz' | 'lb' | 'kg';
  distanceUnit?: 'cm' | 'in';
}

export interface ProviderShipmentItem {
  orderItemId: string;
  productTitle?: string | undefined;
  quantity: number;
  unitPrice?: number | undefined;
}

export interface ProviderCreateShipmentInput {
  sellerOrderId: string;
  customerOrderId: string;
  senderAddress: CarrierAddress;
  recipientAddress: CarrierAddress;
  items: ProviderShipmentItem[];
  carrier?: string | undefined;
  trackingNumber?: string | undefined;
  serviceLevel?: string | undefined;
  parcel?: CarrierParcel | undefined;
  idempotencyKey?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ProviderShipmentResult {
  carrierShipmentId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | null | undefined;
  labelUrl?: string | null | undefined;
  status: ShipmentStatus;
  estimatedDeliveryAt?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ProviderCancelResult {
  cancelled: boolean;
  carrierShipmentId: string;
  reason?: string | undefined;
}

export interface ProviderCreateReturnInput {
  returnId: string;
  sellerOrderId: string;
  customerOrderId: string;
  senderAddress: CarrierAddress;
  recipientAddress: CarrierAddress;
  items: Array<{
    orderItemId: string;
    quantity: number;
  }>;
  carrier?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface CarrierTrackingEvent {
  eventId: string;
  carrier: string;
  trackingNumber: string;
  status: ShipmentStatus;
  location?: string | undefined;
  timestamp: string;
  signature?: string | undefined;
}

export interface CarrierProvider {
  readonly name: string;
  createShipment(input: ProviderCreateShipmentInput): Promise<ProviderShipmentResult>;
  getTracking(carrier: string, trackingNumber: string): Promise<CarrierTrackingEvent>;
  cancelShipment(carrierShipmentId: string): Promise<ProviderCancelResult>;
  createReturnShipment(input: ProviderCreateReturnInput): Promise<ProviderShipmentResult>;
  verifyCallbackSignature(
    rawBody: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds?: number,
  ): boolean;
  parseTrackingCallback(rawBody: string): CarrierTrackingEvent;
}

export class MockCarrierProvider implements CarrierProvider {
  readonly name = 'mock_carrier';

  // In-memory stable idempotency ledger for recovery testing
  private readonly shipmentsByIdempotency = new Map<string, ProviderShipmentResult>();
  private readonly trackingStore = new Map<string, CarrierTrackingEvent>();

  async createShipment(input: ProviderCreateShipmentInput): Promise<ProviderShipmentResult> {
    if (input.idempotencyKey && this.shipmentsByIdempotency.has(input.idempotencyKey)) {
      return this.shipmentsByIdempotency.get(input.idempotencyKey)!;
    }

    const carrier = input.carrier?.trim() || 'MockLogistics';
    const carrierShipmentId = `shp_mock_${input.sellerOrderId.slice(0, 8)}_${randomUUID().slice(0, 6)}`;
    const trackingNumber =
      input.trackingNumber?.trim() || `TRK_${randomUUID().slice(0, 8).toUpperCase()}`;
    const trackingUrl = `https://tracking.mocklogistics.com/${carrier.toLowerCase()}/${trackingNumber}`;
    const labelUrl = `https://labels.mocklogistics.com/${carrierShipmentId}.pdf`;

    const result: ProviderShipmentResult = {
      carrierShipmentId,
      carrier,
      trackingNumber,
      trackingUrl,
      labelUrl,
      status: 'READY_TO_SHIP',
      estimatedDeliveryAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      metadata: {
        provider: 'mock_carrier',
        serviceLevel: input.serviceLevel ?? 'STANDARD',
        test: true,
      },
    };

    if (input.idempotencyKey) {
      this.shipmentsByIdempotency.set(input.idempotencyKey, result);
    }

    this.trackingStore.set(`${carrier}:${trackingNumber}`, {
      eventId: `evt_${carrierShipmentId}`,
      carrier,
      trackingNumber,
      status: 'READY_TO_SHIP',
      location: 'Regional Fulfillment Center',
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  async getTracking(carrier: string, trackingNumber: string): Promise<CarrierTrackingEvent> {
    const key = `${carrier}:${trackingNumber}`;
    if (this.trackingStore.has(key)) {
      return this.trackingStore.get(key)!;
    }
    return {
      eventId: `mock_evt_${Date.now()}`,
      carrier,
      trackingNumber,
      status: 'IN_TRANSIT',
      location: 'Transit Hub',
      timestamp: new Date().toISOString(),
    };
  }

  async cancelShipment(carrierShipmentId: string): Promise<ProviderCancelResult> {
    return {
      cancelled: true,
      carrierShipmentId,
      reason: 'Merchant cancelled shipment label',
    };
  }

  async createReturnShipment(input: ProviderCreateReturnInput): Promise<ProviderShipmentResult> {
    if (input.idempotencyKey && this.shipmentsByIdempotency.has(input.idempotencyKey)) {
      return this.shipmentsByIdempotency.get(input.idempotencyKey)!;
    }

    const carrier = input.carrier?.trim() || 'MockLogistics';
    const carrierShipmentId = `ret_shp_${input.returnId.slice(0, 8)}_${randomUUID().slice(0, 6)}`;
    const trackingNumber = `RET_TRK_${randomUUID().slice(0, 8).toUpperCase()}`;

    const result: ProviderShipmentResult = {
      carrierShipmentId,
      carrier,
      trackingNumber,
      trackingUrl: `https://tracking.mocklogistics.com/returns/${trackingNumber}`,
      labelUrl: `https://labels.mocklogistics.com/returns/${carrierShipmentId}.pdf`,
      status: 'READY_TO_SHIP',
      metadata: {
        provider: 'mock_carrier',
        isReturn: true,
        test: true,
      },
    };

    if (input.idempotencyKey) {
      this.shipmentsByIdempotency.set(input.idempotencyKey, result);
    }
    return result;
  }

  verifyCallbackSignature(
    rawBody: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds = 300,
  ): boolean {
    if (!signatureHeader || !secret) return false;

    try {
      // Support timestamped header: t=123456789,v1=hex or direct hex
      if (signatureHeader.includes('t=')) {
        const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
          const [k, v] = item.trim().split('=');
          if (k && v) acc[k] = v;
          return acc;
        }, {});

        const timestampStr = parts['t'];
        const signatureHash = parts['v1'] || parts['sig'];
        if (!timestampStr || !signatureHash) return false;

        const timestamp = parseInt(timestampStr, 10);
        if (Number.isNaN(timestamp)) return false;

        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - timestamp) > toleranceSeconds) {
          return false;
        }

        const signedPayload = `${timestamp}.${rawBody}`;
        const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
        const expectedBuf = Buffer.from(expected, 'utf8');
        const headerBuf = Buffer.from(signatureHash, 'utf8');
        if (expectedBuf.length !== headerBuf.length) return false;
        return timingSafeEqual(expectedBuf, headerBuf);
      }

      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const headerBuf = Buffer.from(signatureHeader, 'utf8');
      if (expectedBuf.length !== headerBuf.length) return false;
      return timingSafeEqual(expectedBuf, headerBuf);
    } catch {
      return false;
    }
  }

  parseTrackingCallback(rawBody: string): CarrierTrackingEvent {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const carrier =
      typeof parsed['carrier'] === 'string' && parsed['carrier'].trim().length > 0
        ? parsed['carrier'].trim()
        : 'MockLogistics';
    const trackingNumber = String(parsed['trackingNumber'] ?? '');
    const status = (parsed['status'] ?? 'IN_TRANSIT') as ShipmentStatus;
    const eventId =
      typeof parsed['eventId'] === 'string' && parsed['eventId'].trim().length > 0
        ? parsed['eventId'].trim()
        : `${carrier}_${trackingNumber}_${status}`;

    return {
      eventId,
      carrier,
      trackingNumber,
      status,
      location: typeof parsed['location'] === 'string' ? parsed['location'] : undefined,
      timestamp:
        typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : new Date().toISOString(),
      signature: typeof parsed['signature'] === 'string' ? parsed['signature'] : undefined,
    };
  }
}
