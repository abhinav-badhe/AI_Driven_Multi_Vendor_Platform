/**
 * ANALYTICS BOUNDED CONTEXT: Models & DTOs
 * Ownership: Analytical facts, dimensions, aggregates, KPI structures, and rebuild contracts.
 * Invariant: Analytics is derived and read-only with respect to transactional business truth.
 */

export type TimeGranularity = 'HOUR' | 'DAY' | 'WEEK' | 'MONTH';

export interface AnalyticsOrderFact {
  factId: string;
  eventId: string;
  tenantId: string;
  orderId: string;
  sellerOrderId: string | null;
  merchantId: string | null;
  customerId: string | null;
  productId: string | null;
  sku: string | null;
  listingId: string | null;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currency: string;
  orderStatus: string;
  orderedAt: string;
  occurredAt: string;
}

export interface AnalyticsPaymentFact {
  factId: string;
  eventId: string;
  tenantId: string;
  paymentIntentId: string;
  orderId: string | null;
  merchantId: string | null;
  amount: string;
  currency: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  failureReason: string | null;
  occurredAt: string;
}

export interface AnalyticsFulfillmentFact {
  factId: string;
  eventId: string;
  tenantId: string;
  shipmentId: string | null;
  returnId: string | null;
  sellerOrderId: string | null;
  merchantId: string | null;
  fulfillmentStatus: string;
  occurredAt: string;
}

export interface AnalyticsSettlementFact {
  factId: string;
  eventId: string;
  tenantId: string;
  settlementId: string;
  merchantId: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossAmount: string;
  commissionAmount: string;
  netPayoutAmount: string;
  currency: string;
  status: string;
  occurredAt: string;
}

export interface AnalyticsCatalogFact {
  factId: string;
  eventId: string;
  tenantId: string;
  entityType: 'PRODUCT' | 'LISTING';
  productId: string | null;
  listingId: string | null;
  merchantId: string | null;
  category: string | null;
  title: string | null;
  status: string;
  occurredAt: string;
}

export interface AnalyticsDailyMetricRecord {
  id: string;
  tenantId: string;
  merchantId: string; // 'ALL' or specific merchant ID
  metricDate: string; // YYYY-MM-DD
  granularity: TimeGranularity;
  currency: string;
  totalOrders: number;
  grossSales: string;
  netSales: string;
  refundAmount: string;
  unitsSold: number;
  paymentSuccessCount: number;
  paymentFailCount: number;
  shipmentCount: number;
  returnCount: number;
  settlementGross: string;
  settlementNet: string;
  updatedAt: string;
}

export interface AnalyticsQuarantineRecord {
  id: string;
  eventId: string;
  eventType: string;
  tenantId: string;
  violationReason: string;
  payloadPreview: string;
  quarantinedAt: string;
}

export interface AnalyticsRebuildAuditRecord {
  id: string;
  tenantId: string;
  rebuiltByActorId: string;
  sourceEventCount: number;
  factsRebuilt: number;
  aggregatesRebuilt: number;
  status: 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt: string;
}

export interface AnalyticsQueryParams {
  tenantId?: string | undefined;
  merchantId?: string | undefined;
  startDate?: string | undefined; // YYYY-MM-DD
  endDate?: string | undefined; // YYYY-MM-DD
  granularity?: TimeGranularity | undefined;
  currency?: string | undefined;
}

export interface PeriodMetadata {
  startDate: string;
  endDate: string;
  granularity: TimeGranularity;
  timezone: 'UTC';
}

export interface CommerceTotals {
  totalOrders: number;
  grossSales: string;
  netSales: string;
  refundAmount: string;
  averageOrderValue: string;
  unitsSold: number;
}

export interface CommerceTrendPoint {
  date: string;
  orders: number;
  grossSales: string;
  netSales: string;
  unitsSold: number;
  refundAmount: string;
}

export interface CommerceKpiDto {
  period: PeriodMetadata;
  currency: string;
  totals: CommerceTotals;
  trends: CommerceTrendPoint[];
  breakdowns: {
    ordersByStatus: Record<string, number>;
  };
  metadata: {
    calculatedAt: string;
    tenantId: string;
    merchantId?: string | undefined;
  };
}

export interface MerchantMetricsPoint {
  merchantId: string;
  totalOrders: number;
  grossSales: string;
  netSales: string;
  refundAmount: string;
  unitsSold: number;
  settlementGross: string;
  settlementNet: string;
}

export interface MerchantAnalyticsDto {
  period: PeriodMetadata;
  currency: string;
  merchants: MerchantMetricsPoint[];
  metadata: {
    calculatedAt: string;
    tenantId: string;
  };
}

export interface ProductPerformancePoint {
  productId: string;
  title: string | null;
  category: string | null;
  unitsSold: number;
  revenue: string;
  orderCount: number;
  refundCount: number;
}

export interface ProductAnalyticsDto {
  period: PeriodMetadata;
  currency: string;
  products: ProductPerformancePoint[];
  metadata: {
    calculatedAt: string;
    tenantId: string;
  };
}

export interface OperationalMetrics {
  paymentSuccessCount: number;
  paymentFailCount: number;
  paymentSuccessRate: string; // e.g. "95.00%"
  paymentFailureRate: string; // e.g. "5.00%"
  shipmentCount: number;
  returnCount: number;
}

export interface OperationalKpiDto {
  period: PeriodMetadata;
  currency: string;
  operations: OperationalMetrics;
  metadata: {
    calculatedAt: string;
    tenantId: string;
  };
}

export interface RebuildAnalyticsResultDto {
  rebuildId: string;
  tenantId: string;
  sourceEventCount: number;
  factsRebuilt: number;
  aggregatesRebuilt: number;
  status: 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt: string;
}

/**
 * Signals consumed by Recommendation Engine via typed read interface.
 */
export interface TrendingProductSignal {
  productId: string;
  unitsSold: number;
  orderCount: number;
}

export interface CustomerPurchaseHistorySignal {
  productId: string;
  purchaseCount: number;
}

export interface CoPurchaseSignal {
  productId: string;
  coPurchaseCount: number;
}

/**
 * Read-only, typed, tenant-aware Analytics interface for recommendation signals.
 */
export interface IAnalyticsRecommendationReader {
  getTrendingProducts(tenantId: string, limit?: number | undefined): Promise<TrendingProductSignal[]>;
  getCustomerPurchaseHistory(tenantId: string, customerId: string): Promise<CustomerPurchaseHistorySignal[]>;
  getCoPurchasedProducts(tenantId: string, sourceProductId: string, limit?: number | undefined): Promise<CoPurchaseSignal[]>;
}

/**
 * Signals consumed by Predictive ML Engine via approved typed read interface.
 */
export interface ProductDailyDemandRecord {
  tenantId: string;
  productId: string;
  sku: string;
  date: string;
  unitsSold: number;
  orderCount: number;
  price: number;
}

export interface InventoryVelocitySignal {
  tenantId: string;
  productId: string;
  sku: string;
  currentOnHand: number;
  reservedQuantity: number;
  velocity7d: number;
  velocity14d: number;
  leadTimeDays: number;
}

export interface CustomerActivitySignal {
  tenantId: string;
  customerId: string;
  recencyDays: number;
  frequency30d: number;
  frequency90d: number;
  totalOrders: number;
  monetaryTotal: number;
}

export interface OrderAnomalySignal {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  lineCount: number;
  totalQuantity: number;
  hourOfDay: number;
  dayOfWeek: number;
}

/**
 * Read-only, typed, tenant-aware Analytics interface for Predictive ML feature extraction.
 */
export interface IAnalyticsMlFeatureReader {
  getProductDailyDemandHistory(tenantId: string, lookbackDays?: number): Promise<ProductDailyDemandRecord[]>;
  getInventoryVelocitySignals(tenantId: string): Promise<InventoryVelocitySignal[]>;
  getCustomerActivitySignals(tenantId: string): Promise<CustomerActivitySignal[]>;
  getOrderAnomalySignals(tenantId: string): Promise<OrderAnomalySignal[]>;
}

