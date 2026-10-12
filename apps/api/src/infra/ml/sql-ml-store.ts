import type { DatabaseConnection } from '../database/connection.js';
import { ConflictError } from '../../errors/app-error.js';
import type {
  DerivedPredictionRecord,
  EntityType,
  IMlStore,
  ModelStatus,
  ModelType,
  RegisteredModelRecord,
  RetrainingPolicyRecord,
  TrainingJobRecord,
} from '../../modules/analytics-ml/index.js';

interface RawModelRow {
  id: string;
  tenant_id: string;
  model_type: ModelType;
  version: string;
  status: ModelStatus;
  algorithm: string;
  hyperparameters: Record<string, unknown> | string;
  feature_version: string;
  training_dataset_id: string;
  data_source_type: 'REAL' | 'BOOTSTRAP';
  prediction_horizon: string;
  metrics:
    | {
        train: Record<string, number>;
        validation: Record<string, number>;
        test: Record<string, number>;
      }
    | string;
  artifact_path?: string | null;
  is_active: boolean;
  rejection_reason?: string | null;
  created_at: string;
  evaluated_at?: string | null;
  approved_at?: string | null;
  retired_at?: string | null;
}

interface RawJobRow {
  id: string;
  tenant_id: string;
  model_type: ModelType;
  trigger_type: 'MANUAL' | 'SCHEDULED' | 'MIN_DATA_THRESHOLD';
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  data_source_type: 'REAL' | 'BOOTSTRAP';
  sample_count: number | string;
  model_id?: string | null;
  error_message?: string | null;
  config?: Record<string, unknown> | string | null;
  started_at: string;
  completed_at?: string | null;
}

interface RawPredictionRow {
  id: string;
  scope_key: string;
  tenant_id: string;
  model_id: string;
  model_version: string;
  model_type: ModelType;
  entity_type: EntityType;
  entity_id: string;
  prediction_value: number | string;
  probability?: number | string | null;
  confidence?: number | string | null;
  horizon: string;
  feature_version: string;
  data_source_type: 'REAL' | 'BOOTSTRAP';
  provenance: Record<string, unknown> | string;
  predicted_at: string;
  expires_at?: string | null;
}

interface RawPolicyRow {
  id: string;
  tenant_id: string;
  model_type: ModelType;
  min_new_orders_threshold: number | string;
  last_trained_order_count: number | string;
  last_trained_at?: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export class SqlMlStore implements IMlStore {
  constructor(private readonly db: DatabaseConnection) {}

  // 1. Model Registry
  async saveModel(model: RegisteredModelRecord): Promise<void> {
    const sql = `
      INSERT INTO ml_models (
        id, tenant_id, model_type, version, status, algorithm, hyperparameters,
        feature_version, training_dataset_id, data_source_type, prediction_horizon,
        metrics, artifact_path, is_active, created_at, evaluated_at, approved_at, retired_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18
      )
      ON CONFLICT (tenant_id, model_type, version) DO UPDATE SET
        status = EXCLUDED.status,
        metrics = EXCLUDED.metrics,
        artifact_path = EXCLUDED.artifact_path,
        is_active = EXCLUDED.is_active,
        evaluated_at = EXCLUDED.evaluated_at,
        approved_at = EXCLUDED.approved_at,
        retired_at = EXCLUDED.retired_at
    `;

    await this.db.query(sql, [
      model.id,
      model.tenantId,
      model.modelType,
      model.version,
      model.status,
      model.algorithm,
      JSON.stringify(model.hyperparameters ?? {}),
      model.featureVersion,
      model.trainingDatasetId,
      model.dataSourceType,
      model.predictionHorizon,
      JSON.stringify(model.metrics ?? {}),
      model.artifactPath ?? null,
      model.isActive,
      model.createdAt,
      model.evaluatedAt ?? null,
      model.approvedAt ?? null,
      model.retiredAt ?? null,
    ]);
  }

  async getModelById(tenantId: string, modelId: string): Promise<RegisteredModelRecord | null> {
    const sql = 'SELECT * FROM ml_models WHERE tenant_id = $1 AND id = $2';
    const res = await this.db.query<RawModelRow>(sql, [tenantId, modelId]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapModelRow(firstRow) : null;
  }

  async getActiveModel(
    tenantId: string,
    modelType: ModelType,
  ): Promise<RegisteredModelRecord | null> {
    const sql = `
      SELECT * FROM ml_models
      WHERE tenant_id = $1 AND model_type = $2 AND is_active = TRUE AND status = 'APPROVED'
      LIMIT 1
    `;
    const res = await this.db.query<RawModelRow>(sql, [tenantId, modelType]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapModelRow(firstRow) : null;
  }

  async listModels(tenantId: string, modelType?: ModelType): Promise<RegisteredModelRecord[]> {
    let sql = 'SELECT * FROM ml_models WHERE tenant_id = $1';
    const params: unknown[] = [tenantId];
    if (modelType) {
      sql += ' AND model_type = $2';
      params.push(modelType);
    }
    sql += ' ORDER BY created_at DESC';

    const res = await this.db.query<RawModelRow>(sql, params);
    return res.rows.map((row) => this.mapModelRow(row));
  }

  async setActiveModel(tenantId: string, modelId: string, modelType: ModelType): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      // Retire currently active models of this type for this tenant
      await tx.query(
        `UPDATE ml_models
         SET is_active = FALSE, status = 'RETIRED', retired_at = NOW()
         WHERE tenant_id = $1 AND model_type = $2 AND is_active = TRUE`,
        [tenantId, modelType],
      );

      // Activate target model
      await tx.query(
        `UPDATE ml_models
         SET is_active = TRUE, status = 'APPROVED', approved_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, modelId],
      );
    });
  }

  async updateModelStatus(
    tenantId: string,
    modelId: string,
    status: ModelStatus,
    _rejectionReason?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ml_models
       SET status = $1, evaluated_at = NOW()
       WHERE tenant_id = $2 AND id = $3`,
      [status, tenantId, modelId],
    );
  }

  // 2. Training Jobs
  async createTrainingJob(job: TrainingJobRecord): Promise<void> {
    const sql = `
      INSERT INTO ml_training_jobs (
        id, tenant_id, model_type, trigger_type, status,
        data_source_type, sample_count, model_id, error_message, config, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
    `;

    try {
      await this.db.query(sql, [
        job.id,
        job.tenantId,
        job.modelType,
        job.triggerType,
        job.status,
        job.dataSourceType,
        job.sampleCount,
        job.modelId ?? null,
        job.errorMessage ?? null,
        JSON.stringify(job.config ?? {}),
        job.startedAt,
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('uq_ml_active_training_job') ||
        msg.includes('duplicate key') ||
        msg.includes('unique constraint')
      ) {
        throw new ConflictError(
          `A training job is already active (PENDING or RUNNING) for tenant ${job.tenantId} ${job.modelType}`,
        );
      }
      throw err;
    }
  }

  async updateTrainingJob(
    jobId: string,
    updates: Partial<
      Pick<
        TrainingJobRecord,
        'status' | 'modelId' | 'errorMessage' | 'completedAt' | 'sampleCount' | 'dataSourceType'
      >
    >,
  ): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${idx++}`);
      params.push(updates.status);
    }
    if (updates.modelId !== undefined) {
      fields.push(`model_id = $${idx++}`);
      params.push(updates.modelId);
    }
    if (updates.errorMessage !== undefined) {
      fields.push(`error_message = $${idx++}`);
      params.push(updates.errorMessage);
    }
    if (updates.sampleCount !== undefined) {
      fields.push(`sample_count = $${idx++}`);
      params.push(updates.sampleCount);
    }
    if (updates.dataSourceType !== undefined) {
      fields.push(`data_source_type = $${idx++}`);
      params.push(updates.dataSourceType);
    }
    if (updates.completedAt !== undefined) {
      fields.push(`completed_at = $${idx++}`);
      params.push(updates.completedAt);
    }

    if (fields.length === 0) return;

    params.push(jobId);
    const sql = `UPDATE ml_training_jobs SET ${fields.join(', ')} WHERE id = $${idx}`;
    await this.db.query(sql, params);
  }

  async getTrainingJobById(tenantId: string, jobId: string): Promise<TrainingJobRecord | null> {
    const sql = 'SELECT * FROM ml_training_jobs WHERE tenant_id = $1 AND id = $2';
    const res = await this.db.query<RawJobRow>(sql, [tenantId, jobId]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapJobRow(firstRow) : null;
  }

  async getLatestRunningJob(
    tenantId: string,
    modelType: ModelType,
  ): Promise<TrainingJobRecord | null> {
    const sql = `
      SELECT * FROM ml_training_jobs
      WHERE tenant_id = $1 AND model_type = $2 AND status IN ('RUNNING', 'PENDING')
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const res = await this.db.query<RawJobRow>(sql, [tenantId, modelType]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapJobRow(firstRow) : null;
  }

  async claimNextPendingJob(): Promise<TrainingJobRecord | null> {
    // In PostgreSQL, direct LIMIT on UPDATE is invalid.
    // We use a concurrency-safe atomic subquery:
    // WHERE id = (SELECT id FROM ml_training_jobs WHERE status = 'PENDING' ORDER BY started_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
    // For test environments (such as pg-mem) that don't support FOR UPDATE SKIP LOCKED, fallback to standard subquery.
    let res;
    try {
      const sqlWithLock = `
        UPDATE ml_training_jobs
        SET status = 'RUNNING'
        WHERE id = (
          SELECT id
          FROM ml_training_jobs
          WHERE status = 'PENDING'
          ORDER BY started_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `;
      res = await this.db.query<RawJobRow>(sqlWithLock);
    } catch {
      const sqlFallback = `
        UPDATE ml_training_jobs
        SET status = 'RUNNING'
        WHERE id = (
          SELECT id
          FROM ml_training_jobs
          WHERE status = 'PENDING'
          ORDER BY started_at ASC
          LIMIT 1
        )
        RETURNING *
      `;
      res = await this.db.query<RawJobRow>(sqlFallback);
    }

    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapJobRow(firstRow) : null;
  }

  async recoverStaleJobs(staleThresholdMs: number): Promise<number> {
    const sql = `
      UPDATE ml_training_jobs
      SET status = 'FAILED',
          error_message = 'Job timed out or worker crashed (stale job recovery)',
          completed_at = NOW()
      WHERE status = 'RUNNING'
        AND started_at < NOW() - ($1 || ' milliseconds')::INTERVAL
    `;
    const res = await this.db.query(sql, [staleThresholdMs]);
    return res.rowCount ?? 0;
  }

  async listTrainingJobs(tenantId: string, modelType?: ModelType): Promise<TrainingJobRecord[]> {
    let sql = 'SELECT * FROM ml_training_jobs WHERE tenant_id = $1';
    const params: unknown[] = [tenantId];
    if (modelType) {
      sql += ' AND model_type = $2';
      params.push(modelType);
    }
    sql += ' ORDER BY started_at DESC';

    const res = await this.db.query<RawJobRow>(sql, params);
    return res.rows.map((row) => this.mapJobRow(row));
  }

  // 3. Derived Predictions
  async savePredictions(predictions: DerivedPredictionRecord[]): Promise<void> {
    if (predictions.length === 0) return;

    const sql = `
      INSERT INTO ml_predictions (
        id, scope_key, tenant_id, model_id, model_version, model_type,
        entity_type, entity_id, prediction_value, probability, confidence,
        horizon, feature_version, data_source_type, provenance, predicted_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17
      )
      ON CONFLICT (scope_key) DO UPDATE SET
        model_id = EXCLUDED.model_id,
        model_version = EXCLUDED.model_version,
        prediction_value = EXCLUDED.prediction_value,
        probability = EXCLUDED.probability,
        confidence = EXCLUDED.confidence,
        provenance = EXCLUDED.provenance,
        predicted_at = EXCLUDED.predicted_at
    `;

    for (const p of predictions) {
      await this.db.query(sql, [
        p.id,
        p.scopeKey,
        p.tenantId,
        p.modelId,
        p.modelVersion,
        p.modelType,
        p.entityType,
        p.entityId,
        p.predictionValue,
        p.probability ?? null,
        p.confidence ?? null,
        p.horizon,
        p.featureVersion,
        p.dataSourceType,
        JSON.stringify(p.provenance ?? {}),
        p.predictedAt,
        p.expiresAt ?? null,
      ]);
    }
  }

  async getPrediction(
    tenantId: string,
    modelType: ModelType,
    entityType: EntityType,
    entityId: string,
  ): Promise<DerivedPredictionRecord | null> {
    const sql = `
      SELECT * FROM ml_predictions
      WHERE tenant_id = $1 AND model_type = $2 AND entity_type = $3 AND entity_id = $4
      LIMIT 1
    `;
    const res = await this.db.query<RawPredictionRow>(sql, [
      tenantId,
      modelType,
      entityType,
      entityId,
    ]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapPredictionRow(firstRow) : null;
  }

  async listPredictions(
    tenantId: string,
    filter?: { modelType?: ModelType; entityType?: EntityType; entityId?: string },
  ): Promise<DerivedPredictionRecord[]> {
    let sql = 'SELECT * FROM ml_predictions WHERE tenant_id = $1';
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (filter?.modelType) {
      sql += ` AND model_type = $${idx++}`;
      params.push(filter.modelType);
    }
    if (filter?.entityType) {
      sql += ` AND entity_type = $${idx++}`;
      params.push(filter.entityType);
    }
    if (filter?.entityId) {
      sql += ` AND entity_id = $${idx++}`;
      params.push(filter.entityId);
    }

    sql += ' ORDER BY predicted_at DESC LIMIT 500';

    const res = await this.db.query<RawPredictionRow>(sql, params);
    return res.rows.map((row) => this.mapPredictionRow(row));
  }

  // 4. Retraining Policies
  async getRetrainingPolicy(
    tenantId: string,
    modelType: ModelType,
  ): Promise<RetrainingPolicyRecord | null> {
    const sql = 'SELECT * FROM ml_retraining_policies WHERE tenant_id = $1 AND model_type = $2';
    const res = await this.db.query<RawPolicyRow>(sql, [tenantId, modelType]);
    if (res.rows.length === 0) return null;
    const firstRow = res.rows[0];
    return firstRow ? this.mapPolicyRow(firstRow) : null;
  }

  async listAllEnabledPolicies(): Promise<RetrainingPolicyRecord[]> {
    const sql = 'SELECT * FROM ml_retraining_policies WHERE enabled = TRUE';
    const res = await this.db.query<RawPolicyRow>(sql);
    return res.rows.map((row) => this.mapPolicyRow(row));
  }

  async saveRetrainingPolicy(policy: RetrainingPolicyRecord): Promise<void> {
    const sql = `
      INSERT INTO ml_retraining_policies (
        id, tenant_id, model_type, min_new_orders_threshold, last_trained_order_count,
        last_trained_at, enabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, model_type) DO UPDATE SET
        min_new_orders_threshold = EXCLUDED.min_new_orders_threshold,
        enabled = EXCLUDED.enabled,
        updated_at = EXCLUDED.updated_at
    `;
    await this.db.query(sql, [
      policy.id,
      policy.tenantId,
      policy.modelType,
      policy.minNewOrdersThreshold,
      policy.lastTrainedOrderCount,
      policy.lastTrainedAt ?? null,
      policy.enabled,
      policy.createdAt,
      policy.updatedAt,
    ]);
  }

  async updateRetrainingPolicyStats(
    tenantId: string,
    modelType: ModelType,
    lastTrainedOrderCount: number,
    lastTrainedAt: string,
  ): Promise<void> {
    const sql = `
      UPDATE ml_retraining_policies
      SET last_trained_order_count = $1, last_trained_at = $2, updated_at = NOW()
      WHERE tenant_id = $3 AND model_type = $4
    `;
    await this.db.query(sql, [lastTrainedOrderCount, lastTrainedAt, tenantId, modelType]);
  }

  // Mappers
  private mapModelRow(row: RawModelRow): RegisteredModelRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      modelType: row.model_type,
      version: row.version,
      status: row.status,
      algorithm: row.algorithm,
      hyperparameters:
        typeof row.hyperparameters === 'string'
          ? JSON.parse(row.hyperparameters)
          : row.hyperparameters,
      featureVersion: row.feature_version,
      trainingDatasetId: row.training_dataset_id,
      dataSourceType: row.data_source_type,
      isSynthetic: row.data_source_type === 'BOOTSTRAP',
      predictionHorizon: row.prediction_horizon,
      metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
      artifactPath: row.artifact_path,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      evaluatedAt: row.evaluated_at,
      approvedAt: row.approved_at,
      retiredAt: row.retired_at,
    };
  }

  private mapJobRow(row: RawJobRow): TrainingJobRecord {
    const config =
      row.config && typeof row.config === 'string'
        ? JSON.parse(row.config)
        : (row.config as Record<string, unknown> | undefined);

    return {
      id: row.id,
      tenantId: row.tenant_id,
      modelType: row.model_type,
      triggerType: row.trigger_type,
      status: row.status,
      dataSourceType: row.data_source_type,
      sampleCount: Number(row.sample_count),
      modelId: row.model_id,
      errorMessage: row.error_message,
      config,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private mapPredictionRow(row: RawPredictionRow): DerivedPredictionRecord {
    return {
      id: row.id,
      scopeKey: row.scope_key,
      tenantId: row.tenant_id,
      modelId: row.model_id,
      modelVersion: row.model_version,
      modelType: row.model_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      predictionValue: Number(row.prediction_value),
      probability:
        row.probability !== null && row.probability !== undefined ? Number(row.probability) : null,
      confidence:
        row.confidence !== null && row.confidence !== undefined ? Number(row.confidence) : null,
      horizon: row.horizon,
      featureVersion: row.feature_version,
      dataSourceType: row.data_source_type,
      isSynthetic: row.data_source_type === 'BOOTSTRAP',
      provenance: typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance,
      predictedAt: row.predicted_at,
      expiresAt: row.expires_at,
    };
  }

  private mapPolicyRow(row: RawPolicyRow): RetrainingPolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      modelType: row.model_type,
      minNewOrdersThreshold: Number(row.min_new_orders_threshold),
      lastTrainedOrderCount: Number(row.last_trained_order_count),
      lastTrainedAt: row.last_trained_at,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
