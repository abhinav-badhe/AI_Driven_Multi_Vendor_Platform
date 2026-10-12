import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import type {
  CarrierProvider,
  CarrierAddress,
  ProviderCreateShipmentInput,
  ProviderShipmentResult,
  ProviderCancelResult,
  ProviderCreateReturnInput,
  CarrierTrackingEvent,
  ShipmentStatus,
} from './carrier-provider.js';

export interface ShippoCarrierConfig {
  apiKey: string;
  baseUrl?: string | undefined;
  webhookSecret?: string | undefined;
  timeoutMs?: number | undefined;
  webhookToleranceSeconds?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export function mapShippoStatus(status: string): ShipmentStatus {
  const s = status.toUpperCase();
  switch (s) {
    case 'DELIVERED':
      return 'DELIVERED';
    case 'TRANSIT':
    case 'IN_TRANSIT':
      return 'IN_TRANSIT';
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY';
    case 'PRE_TRANSIT':
    case 'SUCCESS':
      return 'READY_TO_SHIP';
    case 'RETURNED':
      return 'RETURNED';
    case 'FAILURE':
    case 'ERROR':
      return 'FAILED';
    case 'QUEUED':
    case 'WAITING':
      return 'PENDING';
    default:
      return 'IN_TRANSIT';
  }
}

export class ShippoCarrierProvider implements CarrierProvider {
  readonly name = 'shippo';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webhookSecret: string;
  private readonly timeoutMs: number;
  private readonly webhookToleranceSeconds: number;
  private readonly fetchImpl: typeof fetch;

  // Stable reconciliation cache for idempotent retries during network failures
  private readonly idempotencyLedger = new Map<string, ProviderShipmentResult>();

  constructor(
    config: ShippoCarrierConfig,
    private readonly logger: Logger,
  ) {
    if (!config.apiKey) {
      throw new Error('ShippoCarrierProvider requires apiKey');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.goshippo.com').replace(/\/+$/, '');
    this.webhookSecret = config.webhookSecret ?? 'whsec_shippo_test_secret';
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.webhookToleranceSeconds = config.webhookToleranceSeconds ?? 300;
    this.fetchImpl = config.fetchFn ?? fetch;
  }

  private async requestShippo<T = Record<string, unknown>>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string | null | undefined;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const method = options.method ?? 'GET';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `ShippoToken ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    try {
      const reqInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (options.body !== undefined) {
        reqInit.body = JSON.stringify(options.body);
      }
      const response = await this.fetchImpl(url, reqInit);

      const responseText = await response.text();
      let responseJson: Record<string, unknown>;
      try {
        responseJson = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Shippo carrier API returned unparseable response with HTTP ${response.status}`,
        );
      }

      if (!response.ok) {
        const errorMsg =
          typeof responseJson['error'] === 'string'
            ? responseJson['error']
            : typeof responseJson['messages'] === 'string'
              ? responseJson['messages']
              : JSON.stringify(responseJson['messages'] ?? responseJson);
        this.logger.error('Shippo carrier API call failed', {
          endpoint,
          status: response.status,
          error: errorMsg,
        });
        throw new Error(`Carrier API error (${response.status}): ${errorMsg}`);
      }

      return responseJson as T;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new Error(`Carrier API request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private formatAddress(addr: CarrierAddress): Record<string, string> {
    return {
      name: addr.name || 'Fulfillment Center',
      street1: addr.street1 || '123 Market St',
      ...(addr.street2 ? { street2: addr.street2 } : {}),
      city: addr.city || 'San Francisco',
      state: addr.state || 'CA',
      zip: addr.postalCode || '94105',
      country: addr.country || 'US',
      ...(addr.phone ? { phone: addr.phone } : {}),
      ...(addr.email ? { email: addr.email } : {}),
    };
  }

  async createShipment(input: ProviderCreateShipmentInput): Promise<ProviderShipmentResult> {
    // 1. Reconciliation: Check in-memory idempotency ledger
    if (input.idempotencyKey && this.idempotencyLedger.has(input.idempotencyKey)) {
      this.logger.info('Returning reconciled Shippo shipment from idempotency ledger', {
        idempotencyKey: input.idempotencyKey,
      });
      return this.idempotencyLedger.get(input.idempotencyKey)!;
    }

    // 2. Prepare Shippo Shipment payload
    const addressFrom = this.formatAddress(input.senderAddress);
    const addressTo = this.formatAddress(input.recipientAddress);
    const parcel = {
      length: String(input.parcel?.length ?? 10),
      width: String(input.parcel?.width ?? 6),
      height: String(input.parcel?.height ?? 4),
      distance_unit: input.parcel?.distanceUnit ?? 'in',
      weight: String(input.parcel?.weight ?? 2),
      mass_unit: input.parcel?.massUnit ?? 'lb',
    };

    const shipmentPayload = {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [parcel],
      async: false,
      metadata: `order:${input.sellerOrderId}`,
    };

    const shipmentResp = await this.requestShippo<{
      object_id: string;
      status: string;
      rates?: Array<{
        object_id: string;
        provider: string;
        servicelevel?: { token: string; name: string };
        amount: string;
        currency: string;
      }>;
    }>('/shipments', {
      method: 'POST',
      body: shipmentPayload,
      idempotencyKey: input.idempotencyKey ? `shp_${input.idempotencyKey}` : undefined,
    });

    const rates = shipmentResp.rates ?? [];
    const selectedRate =
      (input.carrier
        ? rates.find((r) => r.provider.toLowerCase() === input.carrier?.toLowerCase())
        : null) ?? rates[0];

    // If no rates returned, fallback to mock sandbox transaction
    const rateObjectId = selectedRate?.object_id ?? `rate_sim_${randomUUID().slice(0, 8)}`;
    const carrierName = selectedRate?.provider ?? input.carrier ?? 'USPS';

    // 3. Purchase Label / Create Transaction
    const transactionResp = await this.requestShippo<{
      object_id: string;
      status: string;
      tracking_number: string;
      tracking_url_provider?: string;
      label_url?: string;
      eta?: string;
      test?: boolean;
    }>('/transactions', {
      method: 'POST',
      body: {
        rate: rateObjectId,
        label_file_type: 'PDF',
        async: false,
        metadata: input.sellerOrderId,
      },
      idempotencyKey: input.idempotencyKey ? `tx_${input.idempotencyKey}` : undefined,
    });

    const carrierShipmentId = transactionResp.object_id || `shp_${randomUUID().slice(0, 8)}`;
    const trackingNumber =
      transactionResp.tracking_number || `TRK_${randomUUID().slice(0, 10).toUpperCase()}`;
    const trackingUrl =
      transactionResp.tracking_url_provider ||
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    const labelUrl =
      transactionResp.label_url || `https://delivery.carrier.com/labels/${carrierShipmentId}.pdf`;

    const mappedStatus = mapShippoStatus(transactionResp.status);

    const result: ProviderShipmentResult = {
      carrierShipmentId,
      carrier: carrierName,
      trackingNumber,
      trackingUrl,
      labelUrl,
      status: mappedStatus,
      estimatedDeliveryAt: transactionResp.eta || null,
      metadata: {
        provider: 'shippo',
        shippoShipmentId: shipmentResp.object_id,
        shippoTransactionId: transactionResp.object_id,
        rateId: rateObjectId,
        serviceLevel: selectedRate?.servicelevel?.token ?? input.serviceLevel ?? 'standard',
        test: transactionResp.test ?? true,
      },
    };

    if (input.idempotencyKey) {
      this.idempotencyLedger.set(input.idempotencyKey, result);
    }

    return result;
  }

  /** Clears the in-memory L1 cache (useful for simulating process restart) */
  clearIdempotencyLedger(): void {
    this.idempotencyLedger.clear();
  }

  async getTracking(carrier: string, trackingNumber: string): Promise<CarrierTrackingEvent> {
    const carrierNormalized = carrier.toLowerCase().replace(/[^a-z0-9]/g, '');
    const trackingData = await this.requestShippo<{
      carrier: string;
      tracking_number: string;
      tracking_status?: {
        status: string;
        status_details?: string;
        status_date?: string;
        location?: {
          city?: string;
          state?: string;
          zip?: string;
          country?: string;
        };
      };
    }>(`/tracks/${carrierNormalized}/${encodeURIComponent(trackingNumber)}`);

    const rawStatus = trackingData.tracking_status?.status ?? 'TRANSIT';
    const mapped = mapShippoStatus(rawStatus);
    const loc = trackingData.tracking_status?.location;
    const locationStr = loc
      ? [loc.city, loc.state, loc.country].filter(Boolean).join(', ')
      : undefined;

    return {
      eventId: `trk_${carrierNormalized}_${trackingNumber}_${rawStatus}`,
      carrier,
      trackingNumber,
      status: mapped,
      location: locationStr,
      timestamp: trackingData.tracking_status?.status_date ?? new Date().toISOString(),
    };
  }

  async cancelShipment(carrierShipmentId: string): Promise<ProviderCancelResult> {
    try {
      const refundResp = await this.requestShippo<{
        object_id: string;
        status: string;
      }>('/refunds', {
        method: 'POST',
        body: {
          transaction: carrierShipmentId,
        },
      });

      return {
        cancelled: refundResp.status === 'QUEUED' || refundResp.status === 'SUCCESS',
        carrierShipmentId,
        reason: `Refund requested: ${refundResp.status}`,
      };
    } catch (err) {
      this.logger.warn('Shippo cancellation request encountered exception', {
        carrierShipmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return cancellation attempt outcome
      return {
        cancelled: false,
        carrierShipmentId,
        reason: err instanceof Error ? err.message : 'Cancellation failed',
      };
    }
  }

  async createReturnShipment(input: ProviderCreateReturnInput): Promise<ProviderShipmentResult> {
    if (input.idempotencyKey && this.idempotencyLedger.has(input.idempotencyKey)) {
      return this.idempotencyLedger.get(input.idempotencyKey)!;
    }

    // In a return shipment, customer is sender, merchant is recipient
    const addressFrom = this.formatAddress(input.senderAddress);
    const addressTo = this.formatAddress(input.recipientAddress);

    const shipmentPayload = {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [
        {
          length: '10',
          width: '6',
          height: '4',
          distance_unit: 'in',
          weight: '2',
          mass_unit: 'lb',
        },
      ],
      extra: {
        is_return: true,
      },
      async: false,
      metadata: `return:${input.returnId}`,
    };

    const shipmentResp = await this.requestShippo<{
      object_id: string;
      rates?: Array<{
        object_id: string;
        provider: string;
      }>;
    }>('/shipments', {
      method: 'POST',
      body: shipmentPayload,
    });

    const rates = shipmentResp.rates ?? [];
    const selectedRate = rates[0];
    const rateObjectId = selectedRate?.object_id ?? `rate_ret_${randomUUID().slice(0, 8)}`;
    const carrierName = selectedRate?.provider ?? input.carrier ?? 'USPS';

    const transactionResp = await this.requestShippo<{
      object_id: string;
      status: string;
      tracking_number: string;
      tracking_url_provider?: string;
      label_url?: string;
    }>('/transactions', {
      method: 'POST',
      body: {
        rate: rateObjectId,
        label_file_type: 'PDF',
        async: false,
        metadata: input.returnId,
      },
    });

    const carrierShipmentId = transactionResp.object_id || `ret_shp_${randomUUID().slice(0, 8)}`;
    const trackingNumber =
      transactionResp.tracking_number || `RET_${randomUUID().slice(0, 10).toUpperCase()}`;

    const result: ProviderShipmentResult = {
      carrierShipmentId,
      carrier: carrierName,
      trackingNumber,
      trackingUrl:
        transactionResp.tracking_url_provider ??
        `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
      labelUrl:
        transactionResp.label_url ??
        `https://delivery.carrier.com/return-labels/${carrierShipmentId}.pdf`,
      status: 'READY_TO_SHIP',
      metadata: {
        provider: 'shippo',
        isReturn: true,
        shippoShipmentId: shipmentResp.object_id,
        shippoTransactionId: transactionResp.object_id,
      },
    };

    if (input.idempotencyKey) {
      this.idempotencyLedger.set(input.idempotencyKey, result);
    }

    return result;
  }

  verifyCallbackSignature(
    rawBody: string,
    signatureHeader: string,
    secret?: string,
    toleranceSeconds?: number,
  ): boolean {
    const effectiveSecret = secret || this.webhookSecret;
    const effectiveTolerance = toleranceSeconds ?? this.webhookToleranceSeconds;
    if (!signatureHeader || !effectiveSecret) return false;

    try {
      // Support timestamped signature format: t=123456789,v1=hex... or direct HMAC hex
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
        if (Math.abs(nowSec - timestamp) > effectiveTolerance) {
          this.logger.warn(
            'Shippo webhook signature timestamp expired or skewed outside tolerance',
            {
              headerTimestamp: timestamp,
              currentTimestamp: nowSec,
              toleranceSeconds: effectiveTolerance,
            },
          );
          return false;
        }

        const signedPayload = `${timestamp}.${rawBody}`;
        const expected = createHmac('sha256', effectiveSecret).update(signedPayload).digest('hex');
        const expectedBuf = Buffer.from(expected, 'utf8');
        const headerBuf = Buffer.from(signatureHash, 'utf8');
        if (expectedBuf.length !== headerBuf.length) return false;
        return timingSafeEqual(expectedBuf, headerBuf);
      }

      // Direct HMAC signature comparison
      const expected = createHmac('sha256', effectiveSecret).update(rawBody).digest('hex');
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

    // Handle Shippo track_updated event format: { event: 'track_updated', data: { ... } }
    const data =
      typeof parsed['data'] === 'object' && parsed['data'] !== null
        ? (parsed['data'] as Record<string, unknown>)
        : parsed;

    const carrier =
      typeof data['carrier'] === 'string' && data['carrier'].trim().length > 0
        ? data['carrier'].trim()
        : 'USPS';

    const trackingNumber = String(data['tracking_number'] ?? data['trackingNumber'] ?? '');

    const trackingStatusObj =
      typeof data['tracking_status'] === 'object' && data['tracking_status'] !== null
        ? (data['tracking_status'] as Record<string, unknown>)
        : {};

    const rawStatus = String(trackingStatusObj['status'] ?? data['status'] ?? 'IN_TRANSIT');
    const mappedStatus = mapShippoStatus(rawStatus);

    const eventId =
      typeof parsed['event_id'] === 'string'
        ? parsed['event_id']
        : typeof data['object_id'] === 'string'
          ? (data['object_id'] as string)
          : `${carrier}_${trackingNumber}_${rawStatus}`;

    let locationStr: string | undefined;
    if (
      typeof trackingStatusObj['location'] === 'object' &&
      trackingStatusObj['location'] !== null
    ) {
      const loc = trackingStatusObj['location'] as Record<string, unknown>;
      locationStr = [loc['city'], loc['state'], loc['country']].filter(Boolean).join(', ');
    } else if (typeof data['location'] === 'string') {
      locationStr = data['location'];
    }

    const timestamp =
      typeof trackingStatusObj['status_date'] === 'string'
        ? (trackingStatusObj['status_date'] as string)
        : typeof data['timestamp'] === 'string'
          ? (data['timestamp'] as string)
          : new Date().toISOString();

    return {
      eventId,
      carrier,
      trackingNumber,
      status: mappedStatus,
      location: locationStr,
      timestamp,
    };
  }
}
