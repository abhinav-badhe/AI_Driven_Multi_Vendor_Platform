import { ValidationError } from '../errors/app-error.js';

export interface EventMetadata {
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  source?: string;
  [key: string]: unknown;
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  occurredAt: string;
  payload: TPayload;
  metadata: EventMetadata;
}

export type ConsumerProcessResult =
  | { status: 'PROCESSED'; eventId: string }
  | { status: 'ALREADY_COMPLETED'; eventId: string }
  | { status: 'CURRENTLY_PROCESSING'; eventId: string }
  | { status: 'FAILED'; eventId: string; error: string };

export const NotificationEventTypes = {
  ORDER_CREATED: 'order.created.v1',
  PAYMENT_SUCCEEDED: 'payment.succeeded.v1',
  PAYMENT_FAILED: 'payment.failed.v1',
  FULFILLMENT_SHIPMENT_STATUS_CHANGED: 'fulfillment.shipment_status_changed.v1',
  FULFILLMENT_RETURN_STATUS_CHANGED: 'fulfillment.return_status_changed.v1',
  SETTLEMENT_STATUS_CHANGED: 'settlement.status_changed.v1',
} as const;

export type NotificationEventType =
  (typeof NotificationEventTypes)[keyof typeof NotificationEventTypes];

export interface IEventSubscriptionTransport {
  subscribe(
    eventType: string,
    handler: (event: DomainEvent) => Promise<void>,
  ): void | Promise<void>;
}

// Canonical supported event versions registry
export const SUPPORTED_EVENT_VERSIONS: Record<string, number[]> = {
  'catalog.product.created.v1': [1],
  'catalog.product.updated.v1': [1],
  'catalog.product.archived.v1': [1],
  'marketplace.listing.created.v1': [1],
  'marketplace.listing.updated.v1': [1],
  'marketplace.listing.deactivated.v1': [1],
  'inventory.stock_changed.v1': [1],
  'inventory.stock_available.v1': [1],
  'order.created.v1': [1],
  'order.status_changed.v1': [1],
  'payment.succeeded.v1': [1],
  'payment.failed.v1': [1],
  'payment.refund_created.v1': [1],
  'fulfillment.shipment_created.v1': [1],
  'fulfillment.shipment_status_changed.v1': [1],
  'fulfillment.return_status_changed.v1': [1],
  'settlement.status_changed.v1': [1],
  'promotion.created.v1': [1],
  'promotion.updated.v1': [1],
  'promotion.activated.v1': [1],
  'promotion.deactivated.v1': [1],
  'promotion.coupon_redeemed.v1': [1],
  'promotion.coupon_redemption_reversed.v1': [1],
  'review.submitted.v1': [1],
  'review.approved.v1': [1],
  'review.rejected.v1': [1],
  'review.updated.v1': [1],
  'review.deleted.v1': [1],
  'wishlist.item_added.v1': [1],
  'wishlist.item_removed.v1': [1],
  'customer.back_in_stock.subscribed.v1': [1],
  'customer.back_in_stock.unsubscribed.v1': [1],
  'customer.back_in_stock.notification_sent.v1': [1],
};

export function isEventVersionSupported(eventType: string, version: number): boolean {
  const versions = SUPPORTED_EVENT_VERSIONS[eventType];
  return versions ? versions.includes(version) : false;
}

// Canonical forbidden security-sensitive keys to guard against PII/credential leaks
export const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'password',
  'password_hash',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'token',
  'secret',
  'authorization',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
]);

export function inspectForSensitiveKeys(obj: unknown, path = ''): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)) {
      throw new ValidationError(
        `Security violation: Prohibited sensitive key '${path}${key}' detected in event payload.`,
      );
    }
    if (value && typeof value === 'object') {
      inspectForSensitiveKeys(value, `${path}${key}.`);
    }
  }
}
