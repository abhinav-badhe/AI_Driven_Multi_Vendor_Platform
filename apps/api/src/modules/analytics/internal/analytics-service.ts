import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import { ForbiddenError, ValidationError, InternalError } from '../../../errors/app-error.js';
import type { DomainEvent } from '../../events/index.js';
import { EventTypes } from '../../events/index.js';
import type {
  AnalyticsQueryParams,
  CommerceKpiDto,
  MerchantAnalyticsDto,
  ProductAnalyticsDto,
  OperationalKpiDto,
  RebuildAnalyticsResultDto,
  TimeGranularity,
  CommerceTrendPoint,
  TrendingProductSignal,
  CustomerPurchaseHistorySignal,
  CoPurchaseSignal,
  IAnalyticsRecommendationReader,
  ProductDailyDemandRecord,
  InventoryVelocitySignal,
  CustomerActivitySignal,
  IAnalyticsMlFeatureReader,
} from './analytics-models.js';
import { AnalyticsRepository, formatMoney } from './analytics-repository.js';

export class AnalyticsService implements IAnalyticsRecommendationReader, IAnalyticsMlFeatureReader {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly repo: AnalyticsRepository = new AnalyticsRepository(),
  ) {}

  /**
   * Enforce tenant isolation and role restrictions for analytical queries.
   */
  private resolveQueryScope(
    actor: AuthorizedActor,
    params: AnalyticsQueryParams,
  ): AnalyticsQueryParams {
    // 1. Role-based restrictions
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers do not have access to analytics');
    }

    // 2. Tenant boundary:
    let effectiveTenantId = actor.tenantId;
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'analytics:read-any');
      if (params.tenantId) {
        effectiveTenantId = params.tenantId;
      }
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'analytics:read-own');
      if (params.tenantId && params.tenantId !== actor.tenantId) {
        throw new ForbiddenError('Merchants may only access their own tenant analytics');
      }
    }

    if (!effectiveTenantId) {
      throw new ValidationError('Tenant ID is required for analytics queries');
    }

    // 3. Merchant boundary:
    let effectiveMerchantId = params.merchantId;
    if (actor.role === 'MERCHANT') {
      if (params.merchantId && params.merchantId !== actor.tenantId) {
        throw new ForbiddenError('Merchants may only access their own analytics data');
      }
      effectiveMerchantId = actor.tenantId;
    }

    return {
      ...params,
      tenantId: effectiveTenantId,
      merchantId: effectiveMerchantId,
      currency: params.currency ?? 'INR',
      granularity: params.granularity ?? 'DAY',
    };
  }

  /**
   * Get Commerce KPIs (Total Orders, Gross Sales, Net Sales, Refunds, AOV, Units Sold, Trends, Breakdowns).
   */
  async getCommerceKpis(
    actor: AuthorizedActor,
    params: AnalyticsQueryParams,
  ): Promise<CommerceKpiDto> {
    const scope = this.resolveQueryScope(actor, params);
    const startDate = scope.startDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = scope.endDate ?? new Date().toISOString().slice(0, 10);
    const queryParams: AnalyticsQueryParams = {
      ...scope,
      startDate,
      endDate,
    };

    const dailyMetrics = await this.repo.queryDailyMetrics(this.db, queryParams);
    const breakdowns = await this.repo.queryOrderStatusBreakdown(this.db, queryParams);

    // Compute totals
    let totalOrders = 0;
    let grossSalesNum = 0;
    let netSalesNum = 0;
    let refundNum = 0;
    let unitsSold = 0;

    const trends: CommerceTrendPoint[] = [];

    for (const m of dailyMetrics) {
      totalOrders += m.totalOrders;
      grossSalesNum += parseFloat(m.grossSales);
      netSalesNum += parseFloat(m.netSales);
      refundNum += parseFloat(m.refundAmount);
      unitsSold += m.unitsSold;

      trends.push({
        date: m.metricDate,
        orders: m.totalOrders,
        grossSales: m.grossSales,
        netSales: m.netSales,
        unitsSold: m.unitsSold,
        refundAmount: m.refundAmount,
      });
    }

    const aovNum = totalOrders > 0 ? grossSalesNum / totalOrders : 0;

    return {
      period: {
        startDate,
        endDate,
        granularity: scope.granularity as TimeGranularity,
        timezone: 'UTC',
      },
      currency: scope.currency ?? 'INR',
      totals: {
        totalOrders,
        grossSales: formatMoney(grossSalesNum),
        netSales: formatMoney(netSalesNum),
        refundAmount: formatMoney(refundNum),
        averageOrderValue: formatMoney(aovNum),
        unitsSold,
      },
      trends,
      breakdowns: {
        ordersByStatus: breakdowns,
      },
      metadata: {
        calculatedAt: new Date().toISOString(),
        tenantId: scope.tenantId!,
        merchantId: scope.merchantId !== 'ALL' ? scope.merchantId : undefined,
      },
    };
  }

  /**
   * Get Merchant-level Analytics breakdown.
   */
  async getMerchantAnalytics(
    actor: AuthorizedActor,
    params: AnalyticsQueryParams,
  ): Promise<MerchantAnalyticsDto> {
    const scope = this.resolveQueryScope(actor, params);
    const startDate = scope.startDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = scope.endDate ?? new Date().toISOString().slice(0, 10);

    const merchants = await this.repo.queryMerchantMetrics(this.db, {
      ...scope,
      startDate,
      endDate,
    });

    return {
      period: {
        startDate,
        endDate,
        granularity: scope.granularity as TimeGranularity,
        timezone: 'UTC',
      },
      currency: scope.currency ?? 'INR',
      merchants,
      metadata: {
        calculatedAt: new Date().toISOString(),
        tenantId: scope.tenantId!,
      },
    };
  }

  /**
   * Get Product-level performance metrics.
   */
  async getProductPerformance(
    actor: AuthorizedActor,
    params: AnalyticsQueryParams,
  ): Promise<ProductAnalyticsDto> {
    const scope = this.resolveQueryScope(actor, params);
    const startDate = scope.startDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = scope.endDate ?? new Date().toISOString().slice(0, 10);

    const products = await this.repo.queryProductPerformance(this.db, {
      ...scope,
      startDate,
      endDate,
    });

    return {
      period: {
        startDate,
        endDate,
        granularity: scope.granularity as TimeGranularity,
        timezone: 'UTC',
      },
      currency: scope.currency ?? 'INR',
      products,
      metadata: {
        calculatedAt: new Date().toISOString(),
        tenantId: scope.tenantId!,
      },
    };
  }

  /**
   * Get Operational KPIs (Payment Success/Fail rates, fulfillment and return counts).
   */
  async getOperationalKpis(
    actor: AuthorizedActor,
    params: AnalyticsQueryParams,
  ): Promise<OperationalKpiDto> {
    const scope = this.resolveQueryScope(actor, params);
    const startDate = scope.startDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = scope.endDate ?? new Date().toISOString().slice(0, 10);

    const metrics = await this.repo.queryDailyMetrics(this.db, {
      ...scope,
      startDate,
      endDate,
    });

    let paymentSuccessCount = 0;
    let paymentFailCount = 0;
    let shipmentCount = 0;
    let returnCount = 0;

    for (const m of metrics) {
      paymentSuccessCount += m.paymentSuccessCount;
      paymentFailCount += m.paymentFailCount;
      shipmentCount += m.shipmentCount;
      returnCount += m.returnCount;
    }

    const totalPayments = paymentSuccessCount + paymentFailCount;
    const paymentSuccessRate =
      totalPayments > 0
        ? ((paymentSuccessCount / totalPayments) * 100).toFixed(2) + '%'
        : '100.00%';
    const paymentFailureRate =
      totalPayments > 0
        ? ((paymentFailCount / totalPayments) * 100).toFixed(2) + '%'
        : '0.00%';

    return {
      period: {
        startDate,
        endDate,
        granularity: scope.granularity as TimeGranularity,
        timezone: 'UTC',
      },
      currency: scope.currency ?? 'INR',
      operations: {
        paymentSuccessCount,
        paymentFailCount,
        paymentSuccessRate,
        paymentFailureRate,
        shipmentCount,
        returnCount,
      },
      metadata: {
        calculatedAt: new Date().toISOString(),
        tenantId: scope.tenantId!,
      },
    };
  }

  /**
   * Ingest a DomainEvent into Analytics facts and update daily aggregates.
   * Performs data quality checks and quarantines invalid records without corrupting state.
   */
  async ingestEvent(
    event: DomainEvent,
    tx?: DatabaseConnection,
  ): Promise<{ success: boolean; quarantined: boolean; reason?: string }> {
    const conn = tx ?? this.db;

    // 1. Data Quality Checks
    if (!event.tenantId || typeof event.tenantId !== 'string' || event.tenantId.trim() === '') {
      await this.quarantine(event, 'MISSING_OR_EMPTY_TENANT_ID', conn);
      return { success: false, quarantined: true, reason: 'MISSING_OR_EMPTY_TENANT_ID' };
    }

    const occurredTimestamp = Date.parse(event.occurredAt);
    if (isNaN(occurredTimestamp)) {
      await this.quarantine(event, 'INVALID_OCCURRED_AT_TIMESTAMP', conn);
      return { success: false, quarantined: true, reason: 'INVALID_OCCURRED_AT_TIMESTAMP' };
    }

    const payload = (event.payload as Record<string, unknown>) || {};
    const metricDate = new Date(occurredTimestamp).toISOString().slice(0, 10);
    const tenantId = event.tenantId;

    try {
      switch (event.eventType) {
        case EventTypes.ORDER_CREATED: {
          const items = Array.isArray(payload.items) ? (payload.items as Record<string, unknown>[]) : [];
          const currency = (payload.currency as string) || 'INR';
          const orderId = (payload.orderId as string) || event.aggregateId;
          const customerId = (payload.customerId as string) || null;
          const existingStatus = await this.repo.getOrderStatus(conn, tenantId, orderId);
          const orderStatus = existingStatus ?? (payload.status as string) ?? 'CREATED';
          const orderedAt = (payload.createdAt as string) || event.occurredAt;

          // Check for negative monetary amounts or negative quantities in payload
          const rawTotal = payload.totalAmount ?? payload.total;
          if (rawTotal !== undefined && Number(rawTotal) < 0) {
            await this.quarantine(event, 'NEGATIVE_TOTAL_AMOUNT', conn);
            return { success: false, quarantined: true, reason: 'NEGATIVE_TOTAL_AMOUNT' };
          }

          if (items.length > 0) {
            for (let i = 0; i < items.length; i++) {
              const item = items[i]!;
              const qty = Number(item.quantity ?? 1);
              const price = Number(item.unitPrice ?? item.price ?? 0);
              if (qty < 0) {
                await this.quarantine(event, 'NEGATIVE_QUANTITY', conn);
                return { success: false, quarantined: true, reason: 'NEGATIVE_QUANTITY' };
              }
              if (price < 0) {
                await this.quarantine(event, 'NEGATIVE_UNIT_PRICE', conn);
                return { success: false, quarantined: true, reason: 'NEGATIVE_UNIT_PRICE' };
              }

              const itemTotal = formatMoney(qty * price);
              const merchantId = (item.merchantId as string) || (payload.merchantId as string) || null;

              await this.repo.recordOrderFact(conn, {
                factId: `fact_ord_${event.eventId}_${i}`,
                eventId: event.eventId,
                tenantId,
                orderId,
                sellerOrderId: (item.sellerOrderId as string) || null,
                merchantId,
                customerId,
                productId: (item.productId as string) || null,
                sku: (item.sku as string) || null,
                listingId: (item.listingId as string) || null,
                quantity: qty,
                unitPrice: formatMoney(price),
                totalAmount: itemTotal,
                currency,
                orderStatus,
                orderedAt,
                occurredAt: event.occurredAt,
              });

              if (merchantId) {
                await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, currency);
              }
            }
          } else {
            // Order event with no line item breakdown
            const total = Number(rawTotal ?? 0);
            const merchantId = (payload.merchantId as string) || null;
            await this.repo.recordOrderFact(conn, {
              factId: `fact_ord_${event.eventId}_0`,
              eventId: event.eventId,
              tenantId,
              orderId,
              sellerOrderId: null,
              merchantId,
              customerId,
              productId: null,
              sku: null,
              listingId: null,
              quantity: 1,
              unitPrice: formatMoney(total),
              totalAmount: formatMoney(total),
              currency,
              orderStatus,
              orderedAt,
              occurredAt: event.occurredAt,
            });

            if (merchantId) {
              await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, currency);
            }
          }

          // Recompute tenant-wide aggregate ('ALL')
          await this.repo.recomputeDailyMetric(conn, tenantId, 'ALL', metricDate, currency);
          break;
        }

        case EventTypes.ORDER_STATUS_CHANGED: {
          const orderId = (payload.orderId as string) || event.aggregateId;
          const newStatus = (payload.status as string) || 'UPDATED';
          const currency = (payload.currency as string) || 'INR';

          const currentStatus = await this.repo.getOrderStatus(conn, tenantId, orderId);

          const statusRank: Record<string, number> = {
            PENDING_PAYMENT: 1,
            CREATED: 2,
            PAID: 2,
            CONFIRMED: 2,
            PROCESSING: 3,
            SHIPPED: 4,
            DELIVERED: 5,
            COMPLETED: 5,
            CANCELLED: 6,
          };

          const currentRank = currentStatus ? (statusRank[currentStatus] ?? 0) : 0;
          const newRank = statusRank[newStatus] ?? 0;

          if (currentStatus && newRank > 0 && currentRank > 0 && newRank < currentRank) {
            this.logger.warn('Ignoring out-of-order order status regression', {
              orderId,
              currentStatus,
              attemptedStatus: newStatus,
              currentRank,
              attemptedRank: newRank,
            });
            return { success: true, quarantined: false };
          }

          if (currentStatus) {
            await this.repo.updateOrderStatus(conn, tenantId, orderId, newStatus);
          } else {
            // Out-of-order: status arrived before order created. Record state placeholder.
            const merchantId = (payload.merchantId as string) || null;
            await this.repo.recordOrderFact(conn, {
              factId: `fact_ord_status_${event.eventId}`,
              eventId: event.eventId,
              tenantId,
              orderId,
              sellerOrderId: (payload.sellerOrderId as string) || null,
              merchantId,
              customerId: (payload.customerId as string) || null,
              productId: null,
              sku: null,
              listingId: null,
              quantity: 0,
              unitPrice: '0.0000',
              totalAmount: '0.0000',
              currency,
              orderStatus: newStatus,
              orderedAt: event.occurredAt,
              occurredAt: event.occurredAt,
            });
          }

          const merchantId = (payload.merchantId as string) || null;
          if (merchantId) {
            await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, currency);
          }
          await this.repo.recomputeDailyMetric(conn, tenantId, 'ALL', metricDate, currency);
          break;
        }

        case EventTypes.PAYMENT_SUCCEEDED:
        case EventTypes.PAYMENT_FAILED:
        case EventTypes.PAYMENT_REFUND_CREATED: {
          const rawAmount = payload.amount;
          if (rawAmount !== undefined && Number(rawAmount) < 0) {
            await this.quarantine(event, 'NEGATIVE_PAYMENT_AMOUNT', conn);
            return { success: false, quarantined: true, reason: 'NEGATIVE_PAYMENT_AMOUNT' };
          }

          const currency = (payload.currency as string) || 'INR';
          const paymentIntentId = (payload.paymentIntentId as string) || event.aggregateId;
          const orderId = (payload.orderId as string) || null;
          const merchantId = (payload.merchantId as string) || null;
          let status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' = 'SUCCEEDED';
          if (event.eventType === EventTypes.PAYMENT_FAILED) status = 'FAILED';
          if (event.eventType === EventTypes.PAYMENT_REFUND_CREATED) status = 'REFUNDED';

          await this.repo.recordPaymentFact(conn, {
            factId: `fact_pay_${event.eventId}`,
            eventId: event.eventId,
            tenantId,
            paymentIntentId,
            orderId,
            merchantId,
            amount: formatMoney(Number(rawAmount ?? 0)),
            currency,
            status,
            failureReason: (payload.reason as string) || null,
            occurredAt: event.occurredAt,
          });

          if (merchantId) {
            await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, currency);
          }
          await this.repo.recomputeDailyMetric(conn, tenantId, 'ALL', metricDate, currency);
          break;
        }

        case EventTypes.FULFILLMENT_SHIPMENT_CREATED:
        case EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED:
        case EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED: {
          const isReturn = event.eventType === EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED;
          const shipmentId = isReturn ? null : ((payload.shipmentId as string) || event.aggregateId);
          const returnId = isReturn ? ((payload.returnId as string) || event.aggregateId) : null;
          const merchantId = (payload.sellerTenantId as string) || (payload.merchantId as string) || null;

          await this.repo.recordFulfillmentFact(conn, {
            factId: `fact_ful_${event.eventId}`,
            eventId: event.eventId,
            tenantId,
            shipmentId,
            returnId,
            sellerOrderId: (payload.sellerOrderId as string) || null,
            merchantId,
            fulfillmentStatus: (payload.status as string) || 'STATUS_CHANGED',
            occurredAt: event.occurredAt,
          });

          if (merchantId) {
            await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, 'INR');
          }
          await this.repo.recomputeDailyMetric(conn, tenantId, 'ALL', metricDate, 'INR');
          break;
        }

        case EventTypes.SETTLEMENT_STATUS_CHANGED: {
          const gross = Number(payload.grossAmount ?? payload.amount ?? 0);
          if (gross < 0) {
            await this.quarantine(event, 'NEGATIVE_SETTLEMENT_AMOUNT', conn);
            return { success: false, quarantined: true, reason: 'NEGATIVE_SETTLEMENT_AMOUNT' };
          }

          const currency = (payload.currency as string) || 'INR';
          const merchantId = (payload.merchantId as string) || (payload.sellerTenantId as string) || 'UNKNOWN';

          await this.repo.recordSettlementFact(conn, {
            factId: `fact_set_${event.eventId}`,
            eventId: event.eventId,
            tenantId,
            settlementId: event.aggregateId,
            merchantId,
            periodStart: (payload.periodStart as string) || null,
            periodEnd: (payload.periodEnd as string) || null,
            grossAmount: formatMoney(gross),
            commissionAmount: formatMoney(Number(payload.commissionAmount ?? 0)),
            netPayoutAmount: formatMoney(Number(payload.netPayoutAmount ?? gross)),
            currency,
            status: (payload.status as string) || 'CALCULATED',
            occurredAt: event.occurredAt,
          });

          await this.repo.recomputeDailyMetric(conn, tenantId, merchantId, metricDate, currency);
          await this.repo.recomputeDailyMetric(conn, tenantId, 'ALL', metricDate, currency);
          break;
        }

        case EventTypes.CATALOG_PRODUCT_CREATED:
        case EventTypes.CATALOG_PRODUCT_UPDATED:
        case EventTypes.CATALOG_PRODUCT_ARCHIVED: {
          await this.repo.recordCatalogFact(conn, {
            factId: `fact_cat_${event.eventId}`,
            eventId: event.eventId,
            tenantId,
            entityType: 'PRODUCT',
            productId: event.aggregateId,
            listingId: null,
            merchantId: null,
            category: (payload.category as string) || null,
            title: (payload.title as string) || null,
            status: (payload.status as string) || 'ACTIVE',
            occurredAt: event.occurredAt,
          });
          break;
        }

        case EventTypes.MARKETPLACE_LISTING_CREATED:
        case EventTypes.MARKETPLACE_LISTING_UPDATED:
        case EventTypes.MARKETPLACE_LISTING_DEACTIVATED: {
          await this.repo.recordCatalogFact(conn, {
            factId: `fact_lst_${event.eventId}`,
            eventId: event.eventId,
            tenantId,
            entityType: 'LISTING',
            productId: (payload.productId as string) || null,
            listingId: event.aggregateId,
            merchantId: (payload.merchantId as string) || null,
            category: null,
            title: (payload.title as string) || null,
            status: (payload.status as string) || 'ACTIVE',
            occurredAt: event.occurredAt,
          });
          break;
        }

        default:
          this.logger.debug('Event ignored by analytics consumer', { eventType: event.eventType });
          break;
      }

      return { success: true, quarantined: false };
    } catch (err) {
      this.logger.error('Error ingesting analytics fact', {
        eventId: event.eventId,
        error: String(err),
      });
      throw err;
    }
  }

  private async quarantine(
    event: DomainEvent,
    reason: string,
    tx?: DatabaseConnection,
  ): Promise<void> {
    this.logger.warn('Quarantining invalid analytical event', { eventId: event.eventId, reason });
    let preview: string;
    try {
      preview = JSON.stringify(event.payload).slice(0, 1000);
    } catch {
      preview = 'Unserializable payload';
    }

    await this.repo.recordQuarantine(tx ?? this.db, {
      id: randomUUID(),
      eventId: event.eventId,
      eventType: event.eventType,
      tenantId: event.tenantId || 'UNKNOWN',
      violationReason: reason,
      payloadPreview: preview,
      quarantinedAt: new Date().toISOString(),
    });
  }

  /**
   * Administrative Rebuild / Reconciliation.
   * Reconstructs all analytical facts and daily metrics for a tenant from outbox_events.
   * Atomic: executes within a transaction. On failure, rolls back completely, logs audit as FAILED,
   * and throws an error rather than silently reporting partial success.
   * Does NOT modify transactional business truth.
   */
  /**
   * Backfills analytics facts straight from transactional order tables for
   * seller orders that never emitted outbox events (e.g. placed before event
   * emission existed). Uses the same ingestEvent path as live events with
   * deterministic IDs, so reruns and the live path never double-count
   * (fact writes are ON CONFLICT DO NOTHING).
   */
  private async backfillOrdersFromTransactions(
    tx: DatabaseConnection,
    tenantId: string,
  ): Promise<number> {
    let factsRebuilt = 0;

    const sellerOrders = await tx.query<{
      id: string;
      customer_order_id: string;
      status: string;
      currency: string;
      total_amount: number | string;
      created_at: string | Date;
    }>(
      `SELECT id, customer_order_id, status, currency, total_amount, created_at
       FROM seller_orders
       WHERE seller_tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId],
    );

    for (const so of sellerOrders.rows) {
      const occurredAt =
        so.created_at instanceof Date ? so.created_at.toISOString() : new Date(so.created_at).toISOString();
      const customerOrder = (
        await tx.query<{
          customer_tenant_id: string;
          currency: string;
          created_at: string | Date;
        }>(
          `SELECT customer_tenant_id, currency, created_at FROM customer_orders WHERE id = $1`,
          [so.customer_order_id],
        )
      ).rows[0];

      const items = await tx.query<{
        product_id: string;
        sku_code: string;
        listing_id: string;
        quantity: number | string;
        unit_price_amount: number | string;
        product_name: string;
      }>(
        `SELECT product_id, sku_code, listing_id, quantity, unit_price_amount, product_name
         FROM order_items WHERE seller_order_id = $1`,
        [so.id],
      );

      const orderEvent: DomainEvent = {
        eventId: `backfill-order-${so.id}`,
        eventType: EventTypes.ORDER_CREATED,
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: so.id,
        tenantId,
        occurredAt,
        payload: {
          orderId: so.id,
          customerOrderId: so.customer_order_id,
          customerId: customerOrder?.customer_tenant_id ?? null,
          merchantId: tenantId,
          currency: so.currency,
          totalAmount: Number(so.total_amount),
          status: so.status,
          createdAt: occurredAt,
          items: items.rows.map((it) => ({
            sellerOrderId: so.id,
            merchantId: tenantId,
            productId: it.product_id,
            sku: it.sku_code,
            listingId: it.listing_id,
            quantity: Number(it.quantity),
            unitPrice: Number(it.unit_price_amount),
            price: Number(it.unit_price_amount),
          })),
        },
        metadata: {},
      };

      const orderResult = await this.ingestEvent(orderEvent, tx);
      if (orderResult.success) factsRebuilt++;

      if (so.status !== 'CANCELLED') {
        const payEvent: DomainEvent = {
          eventId: `backfill-pay-${so.id}`,
          eventType: EventTypes.PAYMENT_SUCCEEDED,
          eventVersion: 1,
          aggregateType: 'payment_intent',
          aggregateId: `backfill-intent-${so.id}`,
          tenantId,
          occurredAt,
          payload: {
            paymentIntentId: `backfill-intent-${so.id}`,
            orderId: so.id,
            merchantId: tenantId,
            amount: Number(so.total_amount),
            currency: so.currency,
          },
          metadata: {},
        };
        const payResult = await this.ingestEvent(payEvent, tx);
        if (payResult.success) factsRebuilt++;
      }
    }

    return factsRebuilt;
  }

  async rebuildProjections(
    actor: AuthorizedActor,
    tenantId: string,
  ): Promise<RebuildAnalyticsResultDto> {
    // Administrators may rebuild any tenant; merchants may rebuild only
    // their own tenant (the query scope below enforces the same boundary).
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'analytics:read-own');
      if (tenantId !== actor.tenantId) {
        throw new ForbiddenError('Merchants may only rebuild their own tenant analytics');
      }
    } else {
      RbacPolicy.requirePermission(actor, 'analytics:rebuild');
    }

    const rebuildId = randomUUID();
    const startedAt = new Date().toISOString();
    let sourceEventCount = 0;
    let factsRebuilt = 0;
    let aggregatesRebuilt = 0;

    this.logger.info('Starting administrative analytics rebuild', { rebuildId, tenantId });

    try {
      await this.db.withTransaction(async (tx) => {
        // 1. Clear existing derived facts and metrics for this tenant first within tx
        await this.repo.clearTenantAnalytics(tx, tenantId);

        // 2. Fetch all outbox events for this tenant within tx
        const eventsRes = await tx.query<{
          event_id: string;
          event_type: string;
          event_version: number;
          aggregate_type: string;
          aggregate_id: string;
          tenant_id: string;
          occurred_at: string | Date;
          payload: string | Record<string, unknown>;
          metadata: string | Record<string, unknown>;
        }>(
          `SELECT * FROM outbox_events
           WHERE tenant_id = $1
           ORDER BY occurred_at ASC`,
          [tenantId],
        );

        sourceEventCount = eventsRes.rows.length;

        // 3. Re-ingest facts from events within the transaction
        for (const row of eventsRes.rows) {
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          const domainEvent: DomainEvent = {
            eventId: row.event_id,
            eventType: row.event_type,
            eventVersion: row.event_version,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            tenantId: row.tenant_id,
            occurredAt: new Date(row.occurred_at).toISOString(),
            payload,
            metadata,
          };

          const result = await this.ingestEvent(domainEvent, tx);
          if (!result.success && !result.quarantined) {
            throw new Error(result.reason ?? 'Event ingestion failed during rebuild');
          }
          if (result.success) {
            factsRebuilt++;
          }
        }

        // 4. Backfill seller orders that never emitted outbox events
        // (orders placed before event emission existed). Deterministic
        // event/fact IDs make this rerun-safe alongside the live path.
        const backfilled = await this.backfillOrdersFromTransactions(tx, tenantId);
        factsRebuilt += backfilled;

        // 5. Count distinct aggregates rebuilt within transaction
        const aggRes = await tx.query<{ count: number | string }>(
          `SELECT COUNT(*) as count FROM analytics_daily_metrics WHERE tenant_id = $1`,
          [tenantId],
        );
        aggregatesRebuilt = Number(aggRes.rows[0]?.count ?? 0);

        // 6. Record rebuild audit entry as COMPLETED within transaction
        await this.repo.recordRebuildAudit(tx, {
          id: rebuildId,
          tenantId,
          rebuiltByActorId: actor.userId,
          sourceEventCount,
          factsRebuilt,
          aggregatesRebuilt,
          status: 'COMPLETED',
          startedAt,
          completedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      // Rebuild failed: transaction rolled back cleanly! Record failure audit on non-transactional db
      const failureReason = err instanceof Error ? err.message : String(err);
      await this.repo.recordRebuildAudit(this.db, {
        id: rebuildId,
        tenantId,
        rebuiltByActorId: actor.userId,
        sourceEventCount,
        factsRebuilt: 0,
        aggregatesRebuilt: 0,
        status: 'FAILED',
        startedAt,
        completedAt: new Date().toISOString(),
      });

      this.logger.error('Analytics rebuild transaction aborted and rolled back', {
        rebuildId,
        tenantId,
        error: failureReason,
      });

      throw new InternalError(`Analytics rebuild failed: ${failureReason}`);
    }

    const completedAt = new Date().toISOString();
    this.logger.info('Analytics rebuild complete', {
      rebuildId,
      sourceEventCount,
      factsRebuilt,
      aggregatesRebuilt,
    });

    return {
      rebuildId,
      tenantId,
      sourceEventCount,
      factsRebuilt,
      aggregatesRebuilt,
      status: 'COMPLETED',
      startedAt,
      completedAt,
    };
  }

  /**
   * --- IAnalyticsRecommendationReader implementation ---
   * Read-only, typed, tenant-aware analytical signals for Recommendations bounded context.
   */
  async getTrendingProducts(tenantId: string, limit = 20): Promise<TrendingProductSignal[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    return this.repo.findTrendingProducts(this.db, tenantId, Math.max(1, Math.min(limit, 100)));
  }

  async getCustomerPurchaseHistory(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPurchaseHistorySignal[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    if (!customerId?.trim()) throw new ValidationError('customerId is required');
    return this.repo.findCustomerPurchaseHistory(this.db, tenantId, customerId);
  }

  async getCoPurchasedProducts(
    tenantId: string,
    sourceProductId: string,
    limit = 20,
  ): Promise<CoPurchaseSignal[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    if (!sourceProductId?.trim()) throw new ValidationError('sourceProductId is required');
    return this.repo.findCoPurchasedProducts(
      this.db,
      tenantId,
      sourceProductId,
      Math.max(1, Math.min(limit, 100)),
    );
  }

  /**
   * --- IAnalyticsMlFeatureReader implementation ---
   * Read-only, typed, tenant-aware analytical feature extracts for Predictive ML bounded context.
   */
  async getProductDailyDemandHistory(
    tenantId: string,
    lookbackDays = 60,
  ): Promise<ProductDailyDemandRecord[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    return this.repo.findProductDailyDemand(this.db, tenantId, Math.max(7, Math.min(lookbackDays, 365)));
  }

  async getInventoryVelocitySignals(tenantId: string): Promise<InventoryVelocitySignal[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    return this.repo.findInventoryVelocitySignals(this.db, tenantId);
  }

  async getCustomerActivitySignals(tenantId: string): Promise<CustomerActivitySignal[]> {
    if (!tenantId?.trim()) throw new ValidationError('tenantId is required');
    return this.repo.findCustomerActivitySignals(this.db, tenantId);
  }
}


