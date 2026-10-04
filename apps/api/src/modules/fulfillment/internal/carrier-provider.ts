import { createHmac, timingSafeEqual } from 'node:crypto';

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
  verifyCallbackSignature(rawBody: string, signatureHeader: string, secret: string): boolean;
  parseTrackingCallback(rawBody: string): CarrierTrackingEvent;
}

export class MockCarrierProvider implements CarrierProvider {
  readonly name = 'mock_carrier';

  verifyCallbackSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
    if (!signatureHeader || !secret) return false;
    try {
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
        typeof parsed['timestamp'] === 'string'
          ? parsed['timestamp']
          : new Date().toISOString(),
      signature: typeof parsed['signature'] === 'string' ? parsed['signature'] : undefined,
    };
  }
}

