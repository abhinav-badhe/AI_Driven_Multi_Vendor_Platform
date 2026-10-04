import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  DerivedRecommendationRecord,
  IRecommendationStore,
  RecommendationType,
  RebuildRecommendationsResultDto,
} from './recommendation-models.js';

export function buildScopeKey(
  tenantId: string,
  type: RecommendationType,
  customerId: string | null | undefined,
  sourceProductId: string | null | undefined,
  recommendedProductId: string,
): string {
  const cust = customerId || 'NONE';
  const src = sourceProductId || 'NONE';
  return `${tenantId}:${type}:${cust}:${src}:${recommendedProductId}`;
}

export class SqlRecommendationStore implements IRecommendationStore {
  constructor(private readonly db: DatabaseConnection) {}

  async saveRecommendations(records: DerivedRecommendationRecord[]): Promise<void> {
    if (records.length === 0) return;

    for (const rec of records) {
      await this.db.query(
        `INSERT INTO derived_recommendations (
          id, scope_key, tenant_id, customer_id, recommendation_type,
          source_product_id, recommended_product_id, rank_position,
          score, reason_code, explanation, derived_metadata,
          created_at, updated_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15
        )
        ON CONFLICT (scope_key) DO UPDATE SET
          rank_position = EXCLUDED.rank_position,
          score = EXCLUDED.score,
          reason_code = EXCLUDED.reason_code,
          explanation = EXCLUDED.explanation,
          derived_metadata = EXCLUDED.derived_metadata,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at`,
        [
          rec.id,
          rec.scopeKey,
          rec.tenantId,
          rec.customerId ?? null,
          rec.recommendationType,
          rec.sourceProductId ?? null,
          rec.recommendedProductId,
          rec.rankPosition,
          rec.score,
          rec.reasonCode,
          rec.explanation,
          JSON.stringify(rec.derivedMetadata || {}),
          rec.createdAt,
          rec.updatedAt,
          rec.expiresAt ?? null,
        ],
      );
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
    const conditions: string[] = ['tenant_id = $1', 'recommendation_type = $2'];
    const values: unknown[] = [tenantId, type];
    let idx = 3;

    if (options?.customerId !== undefined) {
      if (options.customerId === null) {
        conditions.push('customer_id IS NULL');
      } else {
        conditions.push(`customer_id = $${idx++}`);
        values.push(options.customerId);
      }
    }

    if (options?.sourceProductId !== undefined) {
      if (options.sourceProductId === null) {
        conditions.push('source_product_id IS NULL');
      } else {
        conditions.push(`source_product_id = $${idx++}`);
        values.push(options.sourceProductId);
      }
    }

    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    values.push(limit);
    const limitPlaceholder = `$${idx++}`;

    const sql = `
      SELECT
        id, scope_key, tenant_id, customer_id, recommendation_type,
        source_product_id, recommended_product_id, rank_position,
        score, reason_code, explanation, derived_metadata,
        created_at, updated_at, expires_at
      FROM derived_recommendations
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank_position ASC, score DESC
      LIMIT ${limitPlaceholder}
    `;

    const res = await this.db.query<{
      id: string;
      scope_key: string;
      tenant_id: string;
      customer_id: string | null;
      recommendation_type: RecommendationType;
      source_product_id: string | null;
      recommended_product_id: string;
      rank_position: number;
      score: number | string;
      reason_code: string;
      explanation: string;
      derived_metadata: Record<string, unknown> | string;
      created_at: string;
      updated_at: string;
      expires_at: string | null;
    }>(sql, values);

    return res.rows.map((row) => ({
      id: row.id,
      scopeKey: row.scope_key,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      recommendationType: row.recommendation_type,
      sourceProductId: row.source_product_id,
      recommendedProductId: row.recommended_product_id,
      rankPosition: Number(row.rank_position),
      score: Number(row.score),
      reasonCode: row.reason_code as DerivedRecommendationRecord['reasonCode'],
      explanation: row.explanation,
      derivedMetadata:
        typeof row.derived_metadata === 'string'
          ? JSON.parse(row.derived_metadata)
          : row.derived_metadata || {},
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    }));
  }

  async deleteByScope(
    tenantId: string,
    type: RecommendationType,
    customerId?: string | null,
    sourceProductId?: string | null,
  ): Promise<number> {
    const conditions: string[] = ['tenant_id = $1', 'recommendation_type = $2'];
    const values: unknown[] = [tenantId, type];
    let idx = 3;

    if (customerId !== undefined) {
      if (customerId === null) {
        conditions.push('customer_id IS NULL');
      } else {
        conditions.push(`customer_id = $${idx++}`);
        values.push(customerId);
      }
    }

    if (sourceProductId !== undefined) {
      if (sourceProductId === null) {
        conditions.push('source_product_id IS NULL');
      } else {
        conditions.push(`source_product_id = $${idx++}`);
        values.push(sourceProductId);
      }
    }

    const sql = `DELETE FROM derived_recommendations WHERE ${conditions.join(' AND ')}`;
    const res = await this.db.query(sql, values);
    return res.rowCount ?? 0;
  }

  async clearTenantRecommendations(tenantId: string): Promise<number> {
    const res = await this.db.query(
      'DELETE FROM derived_recommendations WHERE tenant_id = $1',
      [tenantId],
    );
    return res.rowCount ?? 0;
  }

  async invalidateProduct(tenantId: string, productId: string): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM derived_recommendations
       WHERE tenant_id = $1 AND (recommended_product_id = $2 OR source_product_id = $2)`,
      [tenantId, productId],
    );
    return res.rowCount ?? 0;
  }

  async recordRebuildAudit(
    audit: Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO recommendation_rebuild_audit (
        id, tenant_id, rebuilt_by_actor_id, recommendations_generated,
        status, error_message, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        audit.id,
        audit.tenantId,
        audit.rebuiltByActorId,
        audit.recommendationsGenerated,
        audit.status,
        audit.error ?? null,
        audit.startedAt,
        audit.completedAt,
      ],
    );
  }
}
