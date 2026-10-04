import { ConflictError } from '../../../errors/app-error.js';
import type {
  DerivedPredictionRecord,
  EntityType,
  IMlStore,
  ModelStatus,
  ModelType,
  RegisteredModelRecord,
  RetrainingPolicyRecord,
  TrainingJobRecord,
} from './ml-models.js';

export class InMemoryMlStore implements IMlStore {
  private readonly models = new Map<string, RegisteredModelRecord>();
  private readonly jobs = new Map<string, TrainingJobRecord>();
  private readonly predictions = new Map<string, DerivedPredictionRecord>();
  private readonly policies = new Map<string, RetrainingPolicyRecord>();

  async saveModel(model: RegisteredModelRecord): Promise<void> {
    this.models.set(model.id, { ...model });
  }

  async getModelById(tenantId: string, modelId: string): Promise<RegisteredModelRecord | null> {
    const m = this.models.get(modelId);
    if (!m || m.tenantId !== tenantId) return null;
    return { ...m };
  }

  async getActiveModel(tenantId: string, modelType: ModelType): Promise<RegisteredModelRecord | null> {
    for (const m of this.models.values()) {
      if (m.tenantId === tenantId && m.modelType === modelType && m.isActive && m.status === 'APPROVED') {
        return { ...m };
      }
    }
    return null;
  }

  async listModels(tenantId: string, modelType?: ModelType): Promise<RegisteredModelRecord[]> {
    const res: RegisteredModelRecord[] = [];
    for (const m of this.models.values()) {
      if (m.tenantId === tenantId && (!modelType || m.modelType === modelType)) {
        res.push({ ...m });
      }
    }
    return res.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async setActiveModel(tenantId: string, modelId: string, modelType: ModelType): Promise<void> {
    for (const [id, m] of this.models.entries()) {
      if (m.tenantId === tenantId && m.modelType === modelType) {
        if (id === modelId) {
          this.models.set(id, { ...m, isActive: true, status: 'APPROVED', approvedAt: new Date().toISOString() });
        } else if (m.isActive) {
          this.models.set(id, { ...m, isActive: false, status: 'RETIRED', retiredAt: new Date().toISOString() });
        }
      }
    }
  }

  async updateModelStatus(
    tenantId: string,
    modelId: string,
    status: ModelStatus,
    rejectionReason?: string,
  ): Promise<void> {
    const m = this.models.get(modelId);
    if (m && m.tenantId === tenantId) {
      this.models.set(modelId, {
        ...m,
        status,
        rejectionReason: rejectionReason ?? m.rejectionReason,
        evaluatedAt: new Date().toISOString(),
      });
    }
  }

  async createTrainingJob(job: TrainingJobRecord): Promise<void> {
    // Database-equivalent uniqueness enforcement for active training jobs
    if (job.status === 'PENDING' || job.status === 'RUNNING') {
      for (const j of this.jobs.values()) {
        if (j.tenantId === job.tenantId && j.modelType === job.modelType && (j.status === 'PENDING' || j.status === 'RUNNING')) {
          throw new ConflictError(
            `A training job (${j.id}) is already active (${j.status}) for ${job.tenantId} ${job.modelType}`,
          );
        }
      }
    }
    this.jobs.set(job.id, { ...job });
  }

  async updateTrainingJob(
    jobId: string,
    updates: Partial<Pick<TrainingJobRecord, 'status' | 'modelId' | 'errorMessage' | 'completedAt' | 'sampleCount' | 'dataSourceType'>>,
  ): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) {
      this.jobs.set(jobId, { ...j, ...updates });
    }
  }

  async getTrainingJobById(tenantId: string, jobId: string): Promise<TrainingJobRecord | null> {
    const j = this.jobs.get(jobId);
    if (!j || j.tenantId !== tenantId) return null;
    return { ...j };
  }

  async getLatestRunningJob(tenantId: string, modelType: ModelType): Promise<TrainingJobRecord | null> {
    for (const j of this.jobs.values()) {
      if (j.tenantId === tenantId && j.modelType === modelType && (j.status === 'RUNNING' || j.status === 'PENDING')) {
        return { ...j };
      }
    }
    return null;
  }

  async claimNextPendingJob(): Promise<TrainingJobRecord | null> {
    for (const [id, j] of this.jobs.entries()) {
      if (j.status === 'PENDING') {
        const claimed: TrainingJobRecord = {
          ...j,
          status: 'RUNNING',
        };
        this.jobs.set(id, claimed);
        return { ...claimed };
      }
    }
    return null;
  }

  async recoverStaleJobs(staleThresholdMs: number): Promise<number> {
    let count = 0;
    const now = Date.now();
    for (const [id, j] of this.jobs.entries()) {
      if (j.status === 'RUNNING') {
        const startedTime = Date.parse(j.startedAt);
        if (now - startedTime > staleThresholdMs) {
          this.jobs.set(id, {
            ...j,
            status: 'FAILED',
            errorMessage: 'Job timed out or worker crashed (stale job recovery)',
            completedAt: new Date().toISOString(),
          });
          count++;
        }
      }
    }
    return count;
  }

  async listTrainingJobs(tenantId: string, modelType?: ModelType): Promise<TrainingJobRecord[]> {
    const res: TrainingJobRecord[] = [];
    for (const j of this.jobs.values()) {
      if (j.tenantId === tenantId && (!modelType || j.modelType === modelType)) {
        res.push({ ...j });
      }
    }
    return res.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async savePredictions(records: DerivedPredictionRecord[]): Promise<void> {
    for (const p of records) {
      this.predictions.set(p.scopeKey, { ...p });
    }
  }

  async getPrediction(
    tenantId: string,
    modelType: ModelType,
    entityType: EntityType,
    entityId: string,
  ): Promise<DerivedPredictionRecord | null> {
    for (const p of this.predictions.values()) {
      if (
        p.tenantId === tenantId &&
        p.modelType === modelType &&
        p.entityType === entityType &&
        p.entityId === entityId
      ) {
        return { ...p };
      }
    }
    return null;
  }

  async listPredictions(
    tenantId: string,
    filter?: { modelType?: ModelType; entityType?: EntityType; entityId?: string },
  ): Promise<DerivedPredictionRecord[]> {
    const res: DerivedPredictionRecord[] = [];
    for (const p of this.predictions.values()) {
      if (p.tenantId !== tenantId) continue;
      if (filter?.modelType && p.modelType !== filter.modelType) continue;
      if (filter?.entityType && p.entityType !== filter.entityType) continue;
      if (filter?.entityId && p.entityId !== filter.entityId) continue;
      res.push({ ...p });
    }
    return res;
  }

  async getRetrainingPolicy(tenantId: string, modelType: ModelType): Promise<RetrainingPolicyRecord | null> {
    const key = `${tenantId}:${modelType}`;
    const pol = this.policies.get(key);
    return pol ? { ...pol } : null;
  }

  async listAllEnabledPolicies(): Promise<RetrainingPolicyRecord[]> {
    const res: RetrainingPolicyRecord[] = [];
    for (const pol of this.policies.values()) {
      if (pol.enabled) {
        res.push({ ...pol });
      }
    }
    return res;
  }

  async saveRetrainingPolicy(policy: RetrainingPolicyRecord): Promise<void> {
    const key = `${policy.tenantId}:${policy.modelType}`;
    this.policies.set(key, { ...policy });
  }

  async updateRetrainingPolicyStats(
    tenantId: string,
    modelType: ModelType,
    lastTrainedOrderCount: number,
    lastTrainedAt: string,
  ): Promise<void> {
    const key = `${tenantId}:${modelType}`;
    const pol = this.policies.get(key);
    if (pol) {
      this.policies.set(key, {
        ...pol,
        lastTrainedOrderCount,
        lastTrainedAt,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

