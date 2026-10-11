import type {
  DerivedRecommendationRecord,
  IRecommendationStore,
  RecommendationType,
  RebuildRecommendationsResultDto,
} from './recommendation-models.js';

/**
 * InMemoryRecommendationStore - Zero-Database In-Memory Recommendation Store.
 *
 * Implements IRecommendationStore in memory for isolated unit testing,
 * local microservice operation, and standalone execution without requiring
 * direct PostgreSQL connectivity.
 */
export class InMemoryRecommendationStore implements IRecommendationStore {
  private readonly records = new Map<string, DerivedRecommendationRecord>();
  private readonly audits: Array<
    Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    }
  > = [];

  async saveRecommendations(records: DerivedRecommendationRecord[]): Promise<void> {
    for (const rec of records) {
      this.records.set(rec.scopeKey, { ...rec });
    }
  }

  async getRecommendations(
    tenantId: string,
    type: RecommendationType,
    options?: {
      customerId?: string | null;
      sourceProductId?: string | null;
      limit?: number;
    },
  ): Promise<DerivedRecommendationRecord[]> {
    const now = new Date().toISOString();
    const matches: DerivedRecommendationRecord[] = [];

    for (const rec of this.records.values()) {
      if (rec.tenantId !== tenantId || rec.recommendationType !== type) {
        continue;
      }

      if (options?.customerId !== undefined) {
        const expectedCustomer = options.customerId ?? null;
        const actualCustomer = rec.customerId ?? null;
        if (actualCustomer !== expectedCustomer) {
          continue;
        }
      }

      if (options?.sourceProductId !== undefined) {
        const expectedSource = options.sourceProductId ?? null;
        const actualSource = rec.sourceProductId ?? null;
        if (actualSource !== expectedSource) {
          continue;
        }
      }

      // Check TTL expiration
      if (rec.expiresAt && rec.expiresAt <= now) {
        continue;
      }

      matches.push({ ...rec });
    }

    matches.sort((a, b) => a.rankPosition - b.rankPosition);

    if (options?.limit && options.limit > 0) {
      return matches.slice(0, options.limit);
    }

    return matches;
  }

  async deleteByScope(
    tenantId: string,
    type: RecommendationType,
    customerId?: string | null,
    sourceProductId?: string | null,
  ): Promise<number> {
    let deletedCount = 0;
    const targetCustomer = customerId ?? null;
    const targetSource = sourceProductId ?? null;

    for (const [key, rec] of this.records.entries()) {
      if (rec.tenantId !== tenantId || rec.recommendationType !== type) {
        continue;
      }

      if (targetCustomer !== null && (rec.customerId ?? null) !== targetCustomer) {
        continue;
      }

      if (targetSource !== null && (rec.sourceProductId ?? null) !== targetSource) {
        continue;
      }

      this.records.delete(key);
      deletedCount++;
    }

    return deletedCount;
  }

  async clearTenantRecommendations(tenantId: string): Promise<number> {
    let deletedCount = 0;
    for (const [key, rec] of this.records.entries()) {
      if (rec.tenantId === tenantId) {
        this.records.delete(key);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async invalidateProduct(tenantId: string, productId: string): Promise<number> {
    let deletedCount = 0;
    for (const [key, rec] of this.records.entries()) {
      if (rec.tenantId === tenantId) {
        if (rec.sourceProductId === productId || rec.recommendedProductId === productId) {
          this.records.delete(key);
          deletedCount++;
        }
      }
    }
    return deletedCount;
  }

  async recordRebuildAudit(
    audit: Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    },
  ): Promise<void> {
    this.audits.push({ ...audit });
  }

  getAudits(): Array<
    Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    }
  > {
    return [...this.audits];
  }

  clear(): void {
    this.records.clear();
    this.audits.length = 0;
  }

  count(): number {
    return this.records.size;
  }
}
