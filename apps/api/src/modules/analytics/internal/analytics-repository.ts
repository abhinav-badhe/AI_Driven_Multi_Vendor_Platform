import type { DatabaseConnection } from '../../../infra/database/connection.js';
import { createHash } from 'node:crypto';
import type {
  AnalyticsOrderFact,
  AnalyticsPaymentFact,
  AnalyticsFulfillmentFact,
  AnalyticsSettlementFact,
  AnalyticsCatalogFact,
  AnalyticsDailyMetricRecord,
  AnalyticsQuarantineRecord,
  AnalyticsRebuildAuditRecord,
  AnalyticsQueryParams,
  MerchantMetricsPoint,
  ProductPerformancePoint,
  TrendingProductSignal,
  CustomerPurchaseHistorySignal,
  CoPurchaseSignal,
  ProductDailyDemandRecord,
  InventoryVelocitySignal,
  CustomerActivitySignal,
  OrderAnomalySignal,
  AnalyticsPromotionFact,
  PromotionAnalyticsDto,
} from './analytics-models.js';

export function formatMoney(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '0.0000';
  const num = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(num) ? '0.0000' : num.toFixed(4);
}


interface RawMetricRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  metric_date: string;
  granularity: string;
  currency: string;
  total_orders: number;
  gross_sales: string;
  net_sales: string;
  refund_amount: string;
  units_sold: number;
  payment_success_count: number;
  payment_fail_count: number;
  shipment_count: number;
  return_count: number;
  settlement_gross: string;
  settlement_net: string;
  updated_at: string | Date;
}

export class AnalyticsRepository {
  /**
   * Idempotently record an immutable order fact from an order event.
   */
  async recordOrderFact(db: DatabaseConnection, fact: AnalyticsOrderFact): Promise<void> {
    await db.query(
      `INSERT INTO analytics_order_facts (
        fact_id, event_id, tenant_id, order_id, seller_order_id, merchant_id,
        customer_id, product_id, sku, listing_id, quantity, unit_price,
        total_amount, currency, order_status, ordered_at, occurred_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
      ON CONFLICT (fact_id) DO NOTHING`,
      [
        fact.factId,
        fact.eventId,
        fact.tenantId,
        fact.orderId,
        fact.sellerOrderId,
        fact.merchantId,
        fact.customerId,
        fact.productId,
        fact.sku,
        fact.listingId,
        fact.quantity,
        formatMoney(fact.unitPrice),
        formatMoney(fact.totalAmount),
        fact.currency,
        fact.orderStatus,
        fact.orderedAt,
        fact.occurredAt,
      ],
    );
  }

  /**
   * Get current order status from order facts for monotonic state validation.
   */
  async getOrderStatus(
    db: DatabaseConnection,
    tenantId: string,
    orderId: string,
  ): Promise<string | null> {
    const res = await db.query<{ order_status: string }>(
      `SELECT order_status FROM analytics_order_facts
       WHERE tenant_id = $1 AND order_id = $2
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [tenantId, orderId],
    );
    return res.rows[0]?.order_status ?? null;
  }

  /**
   * Update order status across existing order facts for an order.
   */
  async updateOrderStatus(
    db: DatabaseConnection,
    tenantId: string,
    orderId: string,
    newStatus: string,
  ): Promise<void> {
    await db.query(
      `UPDATE analytics_order_facts
       SET order_status = $3, updated_at = NOW()
       WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId, newStatus],
    );
  }

  /**
   * Idempotently record a payment fact.
   */
  async recordPaymentFact(db: DatabaseConnection, fact: AnalyticsPaymentFact): Promise<void> {
    await db.query(
      `INSERT INTO analytics_payment_facts (
        fact_id, event_id, tenant_id, payment_intent_id, order_id, merchant_id,
        amount, currency, status, failure_reason, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (event_id) DO NOTHING`,
      [
        fact.factId,
        fact.eventId,
        fact.tenantId,
        fact.paymentIntentId,
        fact.orderId,
        fact.merchantId,
        formatMoney(fact.amount),
        fact.currency,
        fact.status,
        fact.failureReason,
        fact.occurredAt,
      ],
    );
  }

  /**
   * Idempotently record a fulfillment fact.
   */
  async recordFulfillmentFact(db: DatabaseConnection, fact: AnalyticsFulfillmentFact): Promise<void> {
    await db.query(
      `INSERT INTO analytics_fulfillment_facts (
        fact_id, event_id, tenant_id, shipment_id, return_id, seller_order_id,
        merchant_id, fulfillment_status, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (event_id) DO NOTHING`,
      [
        fact.factId,
        fact.eventId,
        fact.tenantId,
        fact.shipmentId,
        fact.returnId,
        fact.sellerOrderId,
        fact.merchantId,
        fact.fulfillmentStatus,
        fact.occurredAt,
      ],
    );
  }

  /**
   * Idempotently record a settlement fact.
   */
  async recordSettlementFact(db: DatabaseConnection, fact: AnalyticsSettlementFact): Promise<void> {
    await db.query(
      `INSERT INTO analytics_settlement_facts (
        fact_id, event_id, tenant_id, settlement_id, merchant_id, period_start,
        period_end, gross_amount, commission_amount, net_payout_amount, currency,
        status, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (event_id) DO NOTHING`,
      [
        fact.factId,
        fact.eventId,
        fact.tenantId,
        fact.settlementId,
        fact.merchantId,
        fact.periodStart,
        fact.periodEnd,
        formatMoney(fact.grossAmount),
        formatMoney(fact.commissionAmount),
        formatMoney(fact.netPayoutAmount),
        fact.currency,
        fact.status,
        fact.occurredAt,
      ],
    );
  }

  /**
   * Idempotently record a catalog/marketplace dimension snapshot fact.
   */
  async recordCatalogFact(db: DatabaseConnection, fact: AnalyticsCatalogFact): Promise<void> {
    await db.query(
      `INSERT INTO analytics_catalog_facts (
        fact_id, event_id, tenant_id, entity_type, product_id, listing_id,
        merchant_id, category, title, status, occurred_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (event_id, entity_type, product_id, listing_id) DO NOTHING`,
      [
        fact.factId,
        fact.eventId,
        fact.tenantId,
        fact.entityType,
        fact.productId,
        fact.listingId,
        fact.merchantId,
        fact.category,
        fact.title,
        fact.status,
        fact.occurredAt,
      ],
    );
  }

  /**
   * Record invalid analytical events into the quarantine log.
   */
  async recordQuarantine(db: DatabaseConnection, record: AnalyticsQuarantineRecord): Promise<void> {
    await db.query(
      `INSERT INTO analytics_quarantine_records (
        id, event_id, event_type, tenant_id, violation_reason, payload_preview, quarantined_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        record.id,
        record.eventId,
        record.eventType,
        record.tenantId,
        record.violationReason,
        record.payloadPreview,
      ],
    );
  }

  /**
   * Deterministically recomputes daily aggregates for a given tenant, merchant, date, and currency
   * from the durable immutable analytical facts.
   */
  async recomputeDailyMetric(
    db: DatabaseConnection,
    tenantId: string,
    merchantId: string, // 'ALL' or specific merchant ID
    metricDate: string, // YYYY-MM-DD
    currency: string,
  ): Promise<void> {
    const dayStart = `${metricDate}T00:00:00.000Z`;
    const nextDayDate = new Date(Date.parse(dayStart) + 86400000).toISOString().slice(0, 10);
    const dayEnd = `${nextDayDate}T00:00:00.000Z`;

    // 1. Sales & Orders Aggregates for that day
    let orderSql = `
      SELECT
        COUNT(DISTINCT order_id) as total_orders,
        COALESCE(SUM(total_amount), 0.0000) as gross_sales,
        COALESCE(SUM(quantity), 0) as units_sold
      FROM analytics_order_facts
      WHERE tenant_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND currency = $4
    `;
    const orderParams: unknown[] = [tenantId, dayStart, dayEnd, currency];
    if (merchantId !== 'ALL') {
      orderSql += ` AND merchant_id = $5`;
      orderParams.push(merchantId);
    }

    const orderRes = await db.query<{
      total_orders: number | string;
      gross_sales: number | string;
      units_sold: number | string;
    }>(orderSql, orderParams);

    const totalOrders = Number(orderRes.rows[0]?.total_orders ?? 0);
    const grossSalesNum = parseFloat(String(orderRes.rows[0]?.gross_sales ?? '0'));
    const unitsSold = Number(orderRes.rows[0]?.units_sold ?? 0);

    // 2. Refund aggregates from payments for that day
    let refundSql = `
      SELECT COALESCE(SUM(amount), 0.0000) as refund_total
      FROM analytics_payment_facts
      WHERE tenant_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND currency = $4
        AND status = 'REFUNDED'
    `;
    const refundParams: unknown[] = [tenantId, dayStart, dayEnd, currency];
    if (merchantId !== 'ALL') {
      refundSql += ` AND merchant_id = $5`;
      refundParams.push(merchantId);
    }
    const refundRes = await db.query<{ refund_total: number | string }>(refundSql, refundParams);
    const refundNum = parseFloat(String(refundRes.rows[0]?.refund_total ?? '0'));
    const netSalesNum = Math.max(0, grossSalesNum - refundNum);

    // 3. Payment operations for that day
    let paySql = `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0) as success_count,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) as fail_count
      FROM analytics_payment_facts
      WHERE tenant_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND currency = $4
    `;
    const payParams: unknown[] = [tenantId, dayStart, dayEnd, currency];
    if (merchantId !== 'ALL') {
      paySql += ` AND merchant_id = $5`;
      payParams.push(merchantId);
    }
    const payRes = await db.query<{ success_count: number | string; fail_count: number | string }>(
      paySql,
      payParams,
    );
    const paymentSuccessCount = Number(payRes.rows[0]?.success_count ?? 0);
    const paymentFailCount = Number(payRes.rows[0]?.fail_count ?? 0);

    // 4. Fulfillment & Return counts for that day
    let fulfillSql = `
      SELECT
        COALESCE(SUM(CASE WHEN shipment_id IS NOT NULL THEN 1 ELSE 0 END), 0) as ship_count,
        COALESCE(SUM(CASE WHEN return_id IS NOT NULL THEN 1 ELSE 0 END), 0) as ret_count
      FROM analytics_fulfillment_facts
      WHERE tenant_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
    `;
    const fulfillParams: unknown[] = [tenantId, dayStart, dayEnd];
    if (merchantId !== 'ALL') {
      fulfillSql += ` AND merchant_id = $4`;
      fulfillParams.push(merchantId);
    }
    const fulfillRes = await db.query<{ ship_count: number | string; ret_count: number | string }>(
      fulfillSql,
      fulfillParams,
    );
    const shipmentCount = Number(fulfillRes.rows[0]?.ship_count ?? 0);
    const returnCount = Number(fulfillRes.rows[0]?.ret_count ?? 0);

    // 5. Settlement amounts for that day
    let settleSql = `
      SELECT
        COALESCE(SUM(gross_amount), 0.0000) as gross_sum,
        COALESCE(SUM(net_payout_amount), 0.0000) as net_sum
      FROM analytics_settlement_facts
      WHERE tenant_id = $1
        AND occurred_at >= $2 AND occurred_at < $3
        AND currency = $4
    `;
    const settleParams: unknown[] = [tenantId, dayStart, dayEnd, currency];
    if (merchantId !== 'ALL') {
      settleSql += ` AND merchant_id = $5`;
      settleParams.push(merchantId);
    }
    const settleRes = await db.query<{ gross_sum: number | string; net_sum: number | string }>(
      settleSql,
      settleParams,
    );
    const settlementGross = formatMoney(settleRes.rows[0]?.gross_sum);
    const settlementNet = formatMoney(settleRes.rows[0]?.net_sum);

    // 6. Upsert into analytics_daily_metrics. The id is a hash because the
    // natural composite key (tenant + merchant UUIDs + date + currency)
    // exceeds the VARCHAR(64) primary key; uniqueness is still enforced by
    // the underlying unique constraint.
    const metricId = createHash('sha256')
      .update(`${tenantId}|${merchantId}|${metricDate}|DAY|${currency}`)
      .digest('hex');
    await db.query(
      `INSERT INTO analytics_daily_metrics (
        id, tenant_id, merchant_id, metric_date, granularity, currency,
        total_orders, gross_sales, net_sales, refund_amount, units_sold,
        payment_success_count, payment_fail_count, shipment_count, return_count,
        settlement_gross, settlement_net, updated_at
      ) VALUES ($1, $2, $3, $4, 'DAY', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (tenant_id, merchant_id, metric_date, granularity, currency)
      DO UPDATE SET
        total_orders = EXCLUDED.total_orders,
        gross_sales = EXCLUDED.gross_sales,
        net_sales = EXCLUDED.net_sales,
        refund_amount = EXCLUDED.refund_amount,
        units_sold = EXCLUDED.units_sold,
        payment_success_count = EXCLUDED.payment_success_count,
        payment_fail_count = EXCLUDED.payment_fail_count,
        shipment_count = EXCLUDED.shipment_count,
        return_count = EXCLUDED.return_count,
        settlement_gross = EXCLUDED.settlement_gross,
        settlement_net = EXCLUDED.settlement_net,
        updated_at = NOW()`,
      [
        metricId,
        tenantId,
        merchantId,
        metricDate,
        currency,
        totalOrders,
        formatMoney(grossSalesNum),
        formatMoney(netSalesNum),
        formatMoney(refundNum),
        unitsSold,
        paymentSuccessCount,
        paymentFailCount,
        shipmentCount,
        returnCount,
        settlementGross,
        settlementNet,
      ],
    );
  }

  /**
   * Query aggregated metrics within a date range.
   */
  async queryDailyMetrics(
    db: DatabaseConnection,
    params: AnalyticsQueryParams,
  ): Promise<AnalyticsDailyMetricRecord[]> {
    const conditions: string[] = ['granularity = $1'];
    const values: unknown[] = [params.granularity ?? 'DAY'];
    let idx = 2;

    if (params.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(params.tenantId);
    }
    if (params.merchantId) {
      conditions.push(`merchant_id = $${idx++}`);
      values.push(params.merchantId);
    } else {
      conditions.push(`merchant_id = 'ALL'`);
    }
    if (params.currency) {
      conditions.push(`currency = $${idx++}`);
      values.push(params.currency);
    }
    if (params.startDate) {
      conditions.push(`metric_date >= $${idx++}`);
      values.push(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`metric_date <= $${idx++}`);
      values.push(params.endDate);
    }

    const sql = `
      SELECT * FROM analytics_daily_metrics
      WHERE ${conditions.join(' AND ')}
      ORDER BY metric_date ASC
    `;

    const res = await db.query<RawMetricRow>(sql, values);
    return res.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      merchantId: row.merchant_id,
      metricDate: row.metric_date,
      granularity: row.granularity as 'HOUR' | 'DAY' | 'WEEK' | 'MONTH',
      currency: row.currency,
      totalOrders: Number(row.total_orders),
      grossSales: formatMoney(row.gross_sales),
      netSales: formatMoney(row.net_sales),
      refundAmount: formatMoney(row.refund_amount),
      unitsSold: Number(row.units_sold),
      paymentSuccessCount: Number(row.payment_success_count),
      paymentFailCount: Number(row.payment_fail_count),
      shipmentCount: Number(row.shipment_count),
      returnCount: Number(row.return_count),
      settlementGross: formatMoney(row.settlement_gross),
      settlementNet: formatMoney(row.settlement_net),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  /**
   * Query order breakdown by order_status for breakdown visualization.
   */
  async queryOrderStatusBreakdown(
    db: DatabaseConnection,
    params: AnalyticsQueryParams,
  ): Promise<Record<string, number>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(params.tenantId);
    }
    if (params.merchantId && params.merchantId !== 'ALL') {
      conditions.push(`merchant_id = $${idx++}`);
      values.push(params.merchantId);
    }
    if (params.currency) {
      conditions.push(`currency = $${idx++}`);
      values.push(params.currency);
    }
    if (params.startDate) {
      conditions.push(`occurred_at >= $${idx++}`);
      values.push(`${params.startDate}T00:00:00.000Z`);
    }
    if (params.endDate) {
      const nextDay = new Date(Date.parse(`${params.endDate}T00:00:00.000Z`) + 86400000).toISOString();
      conditions.push(`occurred_at < $${idx++}`);
      values.push(nextDay);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT order_status, COUNT(DISTINCT order_id) as count
      FROM analytics_order_facts
      ${whereClause}
      GROUP BY order_status
    `;

    const res = await db.query<{ order_status: string; count: number | string }>(sql, values);
    const breakdown: Record<string, number> = {};
    for (const r of res.rows) {
      breakdown[r.order_status] = Number(r.count);
    }
    return breakdown;
  }

  /**
   * Query product-level performance facts.
   */
  async queryProductPerformance(
    db: DatabaseConnection,
    params: AnalyticsQueryParams,
  ): Promise<ProductPerformancePoint[]> {
    const conditions: string[] = ['product_id IS NOT NULL'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(params.tenantId);
    }
    if (params.merchantId && params.merchantId !== 'ALL') {
      conditions.push(`merchant_id = $${idx++}`);
      values.push(params.merchantId);
    }
    if (params.currency) {
      conditions.push(`currency = $${idx++}`);
      values.push(params.currency);
    }
    if (params.startDate) {
      conditions.push(`occurred_at >= $${idx++}`);
      values.push(`${params.startDate}T00:00:00.000Z`);
    }
    if (params.endDate) {
      const nextDay = new Date(Date.parse(`${params.endDate}T00:00:00.000Z`) + 86400000).toISOString();
      conditions.push(`occurred_at < $${idx++}`);
      values.push(nextDay);
    }

    const sql = `
      SELECT
        product_id,
        COALESCE(SUM(quantity), 0) as units_sold,
        COALESCE(SUM(total_amount), 0.0000) as revenue,
        COUNT(DISTINCT order_id) as order_count
      FROM analytics_order_facts
      WHERE ${conditions.join(' AND ')}
      GROUP BY product_id
      ORDER BY revenue DESC
    `;

    const res = await db.query<{
      product_id: string;
      units_sold: number | string;
      revenue: number | string;
      order_count: number | string;
    }>(sql, values);

    // Fetch titles and categories from catalog facts snapshot if available
    const productIds = res.rows.map((r) => r.product_id);
    const titlesMap = new Map<string, { title: string | null; category: string | null }>();

    if (productIds.length > 0 && params.tenantId) {
      const placeholders = productIds.map((_, i) => `$${i + 2}`).join(', ');
      const catRes = await db.query<{ product_id: string; title: string | null; category: string | null }>(
        `SELECT product_id, title, category
         FROM analytics_catalog_facts
         WHERE tenant_id = $1 AND product_id IN (${placeholders})
         ORDER BY occurred_at DESC`,
        [params.tenantId, ...productIds],
      );
      for (const row of catRes.rows) {
        if (!titlesMap.has(row.product_id)) {
          titlesMap.set(row.product_id, { title: row.title, category: row.category });
        }
      }
    }

    return res.rows.map((row) => {
      const meta = titlesMap.get(row.product_id);
      return {
        productId: row.product_id,
        title: meta?.title ?? null,
        category: meta?.category ?? null,
        unitsSold: Number(row.units_sold),
        revenue: formatMoney(row.revenue),
        orderCount: Number(row.order_count),
        refundCount: 0,
      };
    });
  }

  /**
   * Query merchant-level analytics breakdown.
   */
  async queryMerchantMetrics(
    db: DatabaseConnection,
    params: AnalyticsQueryParams,
  ): Promise<MerchantMetricsPoint[]> {
    const conditions: string[] = ["merchant_id IS NOT NULL AND merchant_id != 'ALL'"];
    const values: unknown[] = [];
    let idx = 1;

    if (params.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(params.tenantId);
    }
    if (params.merchantId && params.merchantId !== 'ALL') {
      conditions.push(`merchant_id = $${idx++}`);
      values.push(params.merchantId);
    }
    if (params.currency) {
      conditions.push(`currency = $${idx++}`);
      values.push(params.currency);
    }
    if (params.startDate) {
      conditions.push(`metric_date >= $${idx++}`);
      values.push(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`metric_date <= $${idx++}`);
      values.push(params.endDate);
    }

    const sql = `
      SELECT
        merchant_id,
        COALESCE(SUM(total_orders), 0) as total_orders,
        COALESCE(SUM(gross_sales), 0.0000) as gross_sales,
        COALESCE(SUM(net_sales), 0.0000) as net_sales,
        COALESCE(SUM(refund_amount), 0.0000) as refund_amount,
        COALESCE(SUM(units_sold), 0) as units_sold,
        COALESCE(SUM(settlement_gross), 0.0000) as settlement_gross,
        COALESCE(SUM(settlement_net), 0.0000) as settlement_net
      FROM analytics_daily_metrics
      WHERE ${conditions.join(' AND ')}
      GROUP BY merchant_id
      ORDER BY gross_sales DESC
    `;

    const res = await db.query<{
      merchant_id: string;
      total_orders: number | string;
      gross_sales: number | string;
      net_sales: number | string;
      refund_amount: number | string;
      units_sold: number | string;
      settlement_gross: number | string;
      settlement_net: number | string;
    }>(sql, values);

    return res.rows.map((row) => ({
      merchantId: row.merchant_id,
      totalOrders: Number(row.total_orders),
      grossSales: formatMoney(row.gross_sales),
      netSales: formatMoney(row.net_sales),
      refundAmount: formatMoney(row.refund_amount),
      unitsSold: Number(row.units_sold),
      settlementGross: formatMoney(row.settlement_gross),
      settlementNet: formatMoney(row.settlement_net),
    }));
  }

  /**
   * Log administrative analytics rebuild audit entry.
   */
  async recordRebuildAudit(
    db: DatabaseConnection,
    audit: AnalyticsRebuildAuditRecord,
  ): Promise<void> {
    await db.query(
      `INSERT INTO analytics_rebuild_audit (
        id, tenant_id, rebuilt_by_actor_id, source_event_count,
        facts_rebuilt, aggregates_rebuilt, status, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        audit.id,
        audit.tenantId,
        audit.rebuiltByActorId,
        audit.sourceEventCount,
        audit.factsRebuilt,
        audit.aggregatesRebuilt,
        audit.status,
        audit.startedAt,
        audit.completedAt,
      ],
    );
  }

  /**
   * Clear all analytics facts and daily metrics for a tenant during rebuild.
   */
  async clearTenantAnalytics(db: DatabaseConnection, tenantId: string): Promise<void> {
    await db.query(`DELETE FROM analytics_daily_metrics WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM analytics_order_facts WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM analytics_payment_facts WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM analytics_fulfillment_facts WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM analytics_settlement_facts WHERE tenant_id = $1`, [tenantId]);
    await db.query(`DELETE FROM analytics_catalog_facts WHERE tenant_id = $1`, [tenantId]);
  }

  /**
   * Query trending product signals for recommendations.
   */
  async findTrendingProducts(
    db: DatabaseConnection,
    tenantId: string,
    limit: number,
  ): Promise<TrendingProductSignal[]> {
    const sql = `
      SELECT
        product_id,
        COALESCE(SUM(quantity), 0) as units_sold,
        COUNT(DISTINCT order_id) as order_count
      FROM analytics_order_facts
      WHERE tenant_id = $1 AND product_id IS NOT NULL
      GROUP BY product_id
      ORDER BY units_sold DESC, order_count DESC, product_id ASC
      LIMIT $2
    `;

    const res = await db.query<{
      product_id: string;
      units_sold: number | string;
      order_count: number | string;
    }>(sql, [tenantId, limit]);

    return res.rows.map((row) => ({
      productId: row.product_id,
      unitsSold: Number(row.units_sold),
      orderCount: Number(row.order_count),
    }));
  }

  /**
   * Query customer purchase history signals for personalized recommendations.
   */
  async findCustomerPurchaseHistory(
    db: DatabaseConnection,
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPurchaseHistorySignal[]> {
    const sql = `
      SELECT
        product_id,
        COUNT(*) as purchase_count
      FROM analytics_order_facts
      WHERE tenant_id = $1 AND customer_id = $2 AND product_id IS NOT NULL
      GROUP BY product_id
      ORDER BY purchase_count DESC, product_id ASC
    `;

    const res = await db.query<{
      product_id: string;
      purchase_count: number | string;
    }>(sql, [tenantId, customerId]);

    return res.rows.map((row) => ({
      productId: row.product_id,
      purchaseCount: Number(row.purchase_count),
    }));
  }

  /**
   * Query co-purchased product signals for frequently-bought-together recommendations.
   */
  async findCoPurchasedProducts(
    db: DatabaseConnection,
    tenantId: string,
    sourceProductId: string,
    limit: number,
  ): Promise<CoPurchaseSignal[]> {
    const sql = `
      SELECT
        co.product_id,
        COUNT(DISTINCT co.order_id) as co_purchase_count
      FROM analytics_order_facts primary_item
      JOIN analytics_order_facts co
        ON co.order_id = primary_item.order_id
        AND co.tenant_id = primary_item.tenant_id
        AND co.product_id != primary_item.product_id
      WHERE primary_item.tenant_id = $1
        AND primary_item.product_id = $2
        AND co.product_id IS NOT NULL
      GROUP BY co.product_id
      ORDER BY co_purchase_count DESC, co.product_id ASC
      LIMIT $3
    `;

    const res = await db.query<{
      product_id: string;
      co_purchase_count: number | string;
    }>(sql, [tenantId, sourceProductId, limit]);

    return res.rows.map((row) => ({
      productId: row.product_id,
      coPurchaseCount: Number(row.co_purchase_count),
    }));
  }

  /**
   * Query chronological daily demand history per product for ML Demand Forecasting.
   */
  async findProductDailyDemand(
    db: DatabaseConnection,
    tenantId: string,
    _lookbackDays: number = 60,
  ): Promise<ProductDailyDemandRecord[]> {
    const sql = `
      SELECT
        tenant_id,
        product_id,
        COALESCE(sku, '') as sku,
        SUBSTRING(occurred_at::text, 1, 10) as order_date,
        COALESCE(SUM(quantity), 0) as units_sold,
        COUNT(DISTINCT order_id) as order_count,
        COALESCE(AVG(unit_price), 0) as price
      FROM analytics_order_facts
      WHERE tenant_id = $1 AND product_id IS NOT NULL
      GROUP BY tenant_id, product_id, sku, SUBSTRING(occurred_at::text, 1, 10)
      ORDER BY product_id, order_date ASC
      LIMIT 1000
    `;

    const res = await db.query<{
      tenant_id: string;
      product_id: string;
      sku: string;
      order_date: string;
      units_sold: number | string;
      order_count: number | string;
      price: number | string;
    }>(sql, [tenantId]);

    return res.rows.map((row) => ({
      tenantId: row.tenant_id,
      productId: row.product_id,
      sku: row.sku,
      date: row.order_date,
      unitsSold: Number(row.units_sold),
      orderCount: Number(row.order_count),
      price: Number(row.price),
    }));
  }

  /**
   * Query inventory sales velocity signals for ML Stockout Risk Prediction.
   */
  async findInventoryVelocitySignals(
    db: DatabaseConnection,
    tenantId: string,
  ): Promise<InventoryVelocitySignal[]> {
    const sql = `
      SELECT
        tenant_id,
        product_id,
        COALESCE(sku, '') as sku,
        COALESCE(SUM(quantity), 0) as total_units,
        COUNT(DISTINCT order_id) as order_count
      FROM analytics_order_facts
      WHERE tenant_id = $1 AND product_id IS NOT NULL
      GROUP BY tenant_id, product_id, sku
      ORDER BY total_units DESC
      LIMIT 500
    `;

    const res = await db.query<{
      tenant_id: string;
      product_id: string;
      sku: string;
      total_units: number | string;
      order_count: number | string;
    }>(sql, [tenantId]);

    return res.rows.map((row) => {
      const units = Number(row.total_units);
      const velocity7d = Math.round((units / 4.0) * 100) / 100;
      const velocity14d = Math.round((units / 2.0) * 100) / 100;
      return {
        tenantId: row.tenant_id,
        productId: row.product_id,
        sku: row.sku,
        currentOnHand: 50, // default baseline if real stock is not coupled
        reservedQuantity: 0,
        velocity7d: Math.max(0.5, velocity7d),
        velocity14d: Math.max(1.0, velocity14d),
        leadTimeDays: 3,
      };
    });
  }

  /**
   * Query customer activity signals for ML Customer Purchase Propensity.
   */
  async findCustomerActivitySignals(
    db: DatabaseConnection,
    tenantId: string,
  ): Promise<CustomerActivitySignal[]> {
    const sql = `
      SELECT
        tenant_id,
        customer_id,
        COUNT(DISTINCT order_id) as total_orders,
        COALESCE(SUM(total_amount), 0) as monetary_total,
        MAX(occurred_at) as last_order_at
      FROM analytics_order_facts
      WHERE tenant_id = $1 AND customer_id IS NOT NULL
      GROUP BY tenant_id, customer_id
      ORDER BY total_orders DESC
      LIMIT 500
    `;

    const res = await db.query<{
      tenant_id: string;
      customer_id: string;
      total_orders: number | string;
      monetary_total: number | string;
      last_order_at: string;
    }>(sql, [tenantId]);

    const now = Date.now();
    return res.rows.map((row) => {
      const lastDate = new Date(row.last_order_at).getTime();
      const diffDays = Math.max(1, Math.round((now - lastDate) / (1000 * 60 * 60 * 24)));
      const totOrders = Number(row.total_orders);
      return {
        tenantId: row.tenant_id,
        customerId: row.customer_id,
        recencyDays: isNaN(diffDays) ? 14 : diffDays,
        frequency30d: Math.max(1, Math.round(totOrders / 3)),
        frequency90d: totOrders,
        totalOrders: totOrders,
        monetaryTotal: Number(row.monetary_total),
      };
    });
  }

  /**
   * Query per-order signals for ML Order Anomaly Detection, straight from
   * transactional tables (ground truth, not derived facts).
   */
  async findOrderAnomalySignals(
    db: DatabaseConnection,
    tenantId: string,
  ): Promise<OrderAnomalySignal[]> {
    const sql = `
      SELECT
        so.id AS order_id,
        so.total_amount,
        COUNT(oi.id) AS line_count,
        COALESCE(SUM(oi.quantity), 0) AS total_quantity,
        so.created_at
      FROM seller_orders so
      JOIN order_items oi
        ON oi.seller_order_id = so.id AND oi.merchant_tenant_id = $1
      WHERE so.seller_tenant_id = $1
        AND so.status != 'CANCELLED'
      GROUP BY so.id, so.total_amount, so.created_at
      ORDER BY so.created_at DESC
      LIMIT 500
    `;

    const res = await db.query<{
      order_id: string;
      total_amount: number | string;
      line_count: number | string;
      total_quantity: number | string;
      created_at: string | Date;
    }>(sql, [tenantId]);

    return res.rows.map((row) => {
      const at = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
      return {
        tenantId,
        orderId: row.order_id,
        totalAmount: Number(row.total_amount),
        lineCount: Number(row.line_count),
        totalQuantity: Number(row.total_quantity),
        hourOfDay: isNaN(at.getTime()) ? 12 : at.getHours(),
        dayOfWeek: isNaN(at.getTime()) ? 3 : at.getDay(),
      };
    });
  }

  /**
   * Record promotion redemption fact.
   */
  async recordPromotionFact(
    db: DatabaseConnection,
    fact: AnalyticsPromotionFact,
  ): Promise<void> {
    const sql = `
      INSERT INTO analytics_promotion_facts (
        fact_id, event_id, tenant_id, merchant_id, promotion_id,
        coupon_code, order_id, discount_amount, currency, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (event_id) DO NOTHING
    `;
    await db.query(sql, [
      fact.factId,
      fact.eventId,
      fact.tenantId,
      fact.merchantId ?? null,
      fact.promotionId,
      fact.couponCode ?? null,
      fact.orderId ?? null,
      fact.discountAmount,
      fact.currency,
      fact.occurredAt,
    ]);
  }

  /**
   * Delete promotion fact by event (e.g., reversal).
   */
  async deletePromotionFactByEvent(
    db: DatabaseConnection,
    eventId: string,
  ): Promise<void> {
    await db.query(`DELETE FROM analytics_promotion_facts WHERE event_id = $1`, [eventId]);
  }

  /**
   * Get promotion metrics for merchant or platform.
   */
  async getPromotionMetrics(
    db: DatabaseConnection,
    params: { tenantId: string; merchantId?: string | null | undefined },
  ): Promise<PromotionAnalyticsDto> {
    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [params.tenantId];

    if (params.merchantId) {
      conditions.push('merchant_id = $2');
      values.push(params.merchantId);
    }

    const whereClause = conditions.join(' AND ');

    const summarySql = `
      SELECT
        COUNT(*) as total_redemptions,
        COALESCE(SUM(discount_amount), 0) as total_discount_amount
      FROM analytics_promotion_facts
      WHERE ${whereClause}
    `;

    const summaryRes = await db.query<{
      total_redemptions: number | string;
      total_discount_amount: number | string;
    }>(summarySql, values);

    const breakdownSql = `
      SELECT
        promotion_id,
        coupon_code,
        COUNT(*) as redemption_count,
        COALESCE(SUM(discount_amount), 0) as discount_amount
      FROM analytics_promotion_facts
      WHERE ${whereClause}
      GROUP BY promotion_id, coupon_code
      ORDER BY redemption_count DESC
      LIMIT 100
    `;

    const breakdownRes = await db.query<{
      promotion_id: string;
      coupon_code: string | null;
      redemption_count: number | string;
      discount_amount: number | string;
    }>(breakdownSql, values);

    // Sales attributed to orders that used a promotion
    const salesSql = `
      SELECT COALESCE(SUM(total_amount), 0) as attributed_sales
      FROM customer_orders
      WHERE id IN (
        SELECT order_id FROM analytics_promotion_facts
        WHERE ${whereClause} AND order_id IS NOT NULL
      )
    `;

    const salesRes = await db.query<{ attributed_sales: number | string }>(salesSql, values);

    return {
      totalRedemptions: Number(summaryRes.rows[0]?.total_redemptions ?? 0),
      totalDiscountAmount: Math.round(Number(summaryRes.rows[0]?.total_discount_amount ?? 0)),
      promotionAttributedSales: Math.round(Number(salesRes.rows[0]?.attributed_sales ?? 0)),
      promotions: breakdownRes.rows.map((row) => ({
        promotionId: row.promotion_id,
        couponCode: row.coupon_code,
        redemptionCount: Number(row.redemption_count),
        discountAmount: Math.round(Number(row.discount_amount)),
      })),
    };
  }
}


