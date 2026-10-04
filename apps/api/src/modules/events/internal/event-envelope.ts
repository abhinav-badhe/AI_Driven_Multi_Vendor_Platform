import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../../errors/app-error.js';

export interface EventMetadata {
  correlationId?: string | undefined;
  causationId?: string | undefined;
  actorId?: string | undefined;
  source?: string | undefined;
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

/** Helper to cast a DomainEvent<unknown> to DomainEvent<Record<string, unknown>> safely */
export function asDomainEvent(event: DomainEvent<unknown>): DomainEvent<Record<string, unknown>> {
  return event as DomainEvent<Record<string, unknown>>;
}

// Canonical Event Type Identifiers with explicit major versioning
export const EventTypes = {
  // Catalog Domain Events
  CATALOG_PRODUCT_CREATED: 'catalog.product.created.v1',
  CATALOG_PRODUCT_UPDATED: 'catalog.product.updated.v1',
  CATALOG_PRODUCT_ARCHIVED: 'catalog.product.archived.v1',

  // Marketplace Domain Events
  MARKETPLACE_LISTING_CREATED: 'marketplace.listing.created.v1',
  MARKETPLACE_LISTING_UPDATED: 'marketplace.listing.updated.v1',
  MARKETPLACE_LISTING_DEACTIVATED: 'marketplace.listing.deactivated.v1',

  // Orders Domain Events
  ORDER_CREATED: 'order.created.v1',
  ORDER_STATUS_CHANGED: 'order.status_changed.v1',

  // Payment Domain Events
  PAYMENT_SUCCEEDED: 'payment.succeeded.v1',
  PAYMENT_FAILED: 'payment.failed.v1',
  PAYMENT_REFUND_CREATED: 'payment.refund_created.v1',

  // Fulfillment Domain Events
  FULFILLMENT_SHIPMENT_CREATED: 'fulfillment.shipment_created.v1',
  FULFILLMENT_SHIPMENT_STATUS_CHANGED: 'fulfillment.shipment_status_changed.v1',
  FULFILLMENT_RETURN_STATUS_CHANGED: 'fulfillment.return_status_changed.v1',

  // Settlement Domain Events
  SETTLEMENT_STATUS_CHANGED: 'settlement.status_changed.v1',

  // Inventory Domain Events
  INVENTORY_STOCK_CHANGED: 'inventory.stock_changed.v1',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// Supported versions registry (for consumer backward-compatibility enforcement)
const SUPPORTED_EVENT_VERSIONS: Record<string, number[]> = {
  'catalog.product.created.v1': [1],
  'catalog.product.updated.v1': [1],
  'catalog.product.archived.v1': [1],
  'marketplace.listing.created.v1': [1],
  'marketplace.listing.updated.v1': [1],
  'marketplace.listing.deactivated.v1': [1],
  'inventory.stock_changed.v1': [1],
  'order.created.v1': [1],
  'order.status_changed.v1': [1],
  'payment.succeeded.v1': [1],
  'payment.failed.v1': [1],
  'payment.refund_created.v1': [1],
  'fulfillment.shipment_created.v1': [1],
  'fulfillment.shipment_status_changed.v1': [1],
  'fulfillment.return_status_changed.v1': [1],
  'settlement.status_changed.v1': [1],
};

export function isEventVersionSupported(eventType: string, version: number): boolean {
  const versions = SUPPORTED_EVENT_VERSIONS[eventType];
  return versions ? versions.includes(version) : false;
}

// Prohibited security-sensitive keys to guard against PII/credential leaks
const FORBIDDEN_PAYLOAD_KEYS = new Set([
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

function inspectForSensitiveKeys(obj: unknown, path = ''): void {
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

export interface CreateDomainEventInput<TPayload> {
  eventId?: string;
  eventType: string;
  eventVersion?: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  occurredAt?: string;
  payload: TPayload;
  metadata?: EventMetadata;
}

export function createDomainEvent<TPayload = Record<string, unknown>>(
  input: CreateDomainEventInput<TPayload>,
): DomainEvent<TPayload> {
  if (!input.eventType || typeof input.eventType !== 'string') {
    throw new ValidationError('eventType is required and must be a string');
  }
  if (!input.aggregateType || typeof input.aggregateType !== 'string') {
    throw new ValidationError('aggregateType is required and must be a string');
  }
  if (!input.aggregateId || typeof input.aggregateId !== 'string') {
    throw new ValidationError('aggregateId is required and must be a string');
  }
  if (!input.tenantId || typeof input.tenantId !== 'string') {
    throw new ValidationError('tenantId is required and must be a string');
  }
  if (input.payload === undefined || input.payload === null) {
    throw new ValidationError('payload is required');
  }

  // Security scan for credentials / token leakage
  inspectForSensitiveKeys(input.payload);

  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    tenantId: input.tenantId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    payload: input.payload,
    metadata: {
      correlationId: input.metadata?.correlationId,
      causationId: input.metadata?.causationId,
      actorId: input.metadata?.actorId,
      source: input.metadata?.source ?? 'commerce-api',
    },
  };
}
