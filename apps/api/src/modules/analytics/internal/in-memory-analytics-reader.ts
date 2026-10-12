import type {
  IAnalyticsRecommendationReader,
  IAnalyticsMlFeatureReader,
  TrendingProductSignal,
  CustomerPurchaseHistorySignal,
  CoPurchaseSignal,
  ProductDailyDemandRecord,
  InventoryVelocitySignal,
  CustomerActivitySignal,
  OrderAnomalySignal,
} from './analytics-models.js';

/**
 * InMemoryAnalyticsReader - Zero-Database Analytics Signal Reader.
 *
 * Implements IAnalyticsRecommendationReader and IAnalyticsMlFeatureReader
 * in memory for unit testing, isolated microservice development, and fallback
 * signal provision when the analytical database is offline.
 */
export class InMemoryAnalyticsReader
  implements IAnalyticsRecommendationReader, IAnalyticsMlFeatureReader
{
  private trendingSignals = new Map<string, TrendingProductSignal[]>();
  private purchaseHistories = new Map<string, CustomerPurchaseHistorySignal[]>();
  private coPurchases = new Map<string, CoPurchaseSignal[]>();
  private demandHistories = new Map<string, ProductDailyDemandRecord[]>();
  private velocitySignals = new Map<string, InventoryVelocitySignal[]>();
  private customerActivitySignals = new Map<string, CustomerActivitySignal[]>();
  private anomalySignals = new Map<string, OrderAnomalySignal[]>();

  // Seed / setup helper methods for tests
  setTrendingProducts(tenantId: string, signals: TrendingProductSignal[]): void {
    this.trendingSignals.set(tenantId, [...signals]);
  }

  setCustomerPurchaseHistory(
    tenantId: string,
    customerId: string,
    signals: CustomerPurchaseHistorySignal[],
  ): void {
    this.purchaseHistories.set(`${tenantId}:${customerId}`, [...signals]);
  }

  setCoPurchasedProducts(
    tenantId: string,
    sourceProductId: string,
    signals: CoPurchaseSignal[],
  ): void {
    this.coPurchases.set(`${tenantId}:${sourceProductId}`, [...signals]);
  }

  setProductDailyDemandHistory(tenantId: string, records: ProductDailyDemandRecord[]): void {
    this.demandHistories.set(tenantId, [...records]);
  }

  setInventoryVelocitySignals(tenantId: string, signals: InventoryVelocitySignal[]): void {
    this.velocitySignals.set(tenantId, [...signals]);
  }

  setCustomerActivitySignals(tenantId: string, signals: CustomerActivitySignal[]): void {
    this.customerActivitySignals.set(tenantId, [...signals]);
  }

  setOrderAnomalySignals(tenantId: string, signals: OrderAnomalySignal[]): void {
    this.anomalySignals.set(tenantId, [...signals]);
  }

  // --- IAnalyticsRecommendationReader ---
  async getTrendingProducts(tenantId: string, limit?: number): Promise<TrendingProductSignal[]> {
    const list = this.trendingSignals.get(tenantId) ?? [];
    return limit && limit > 0 ? list.slice(0, limit) : list;
  }

  async getCustomerPurchaseHistory(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPurchaseHistorySignal[]> {
    return this.purchaseHistories.get(`${tenantId}:${customerId}`) ?? [];
  }

  async getCoPurchasedProducts(
    tenantId: string,
    sourceProductId: string,
    limit?: number,
  ): Promise<CoPurchaseSignal[]> {
    const list = this.coPurchases.get(`${tenantId}:${sourceProductId}`) ?? [];
    return limit && limit > 0 ? list.slice(0, limit) : list;
  }

  // --- IAnalyticsMlFeatureReader ---
  async getProductDailyDemandHistory(
    tenantId: string,
    _lookbackDays?: number,
  ): Promise<ProductDailyDemandRecord[]> {
    return this.demandHistories.get(tenantId) ?? [];
  }

  async getInventoryVelocitySignals(tenantId: string): Promise<InventoryVelocitySignal[]> {
    return this.velocitySignals.get(tenantId) ?? [];
  }

  async getCustomerActivitySignals(tenantId: string): Promise<CustomerActivitySignal[]> {
    return this.customerActivitySignals.get(tenantId) ?? [];
  }

  async getOrderAnomalySignals(tenantId: string): Promise<OrderAnomalySignal[]> {
    return this.anomalySignals.get(tenantId) ?? [];
  }

  clear(): void {
    this.trendingSignals.clear();
    this.purchaseHistories.clear();
    this.coPurchases.clear();
    this.demandHistories.clear();
    this.velocitySignals.clear();
    this.customerActivitySignals.clear();
    this.anomalySignals.clear();
  }
}
