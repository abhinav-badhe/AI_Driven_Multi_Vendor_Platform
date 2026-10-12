/**
 * Bounded Context: Analytics & ML
 * Domain models, DTOs, and Store interfaces for Predictive ML.
 */

export type ModelType =
  'DEMAND_FORECASTING' | 'STOCKOUT_RISK' | 'PURCHASE_PROPENSITY' | 'ANOMALY_DETECTION';

export type ModelStatus =
  'TRAINING' | 'EVALUATING' | 'APPROVED' | 'REJECTED' | 'RETIRED' | 'FAILED';

export type DataSourceType = 'REAL' | 'BOOTSTRAP';

export type TriggerType = 'MANUAL' | 'SCHEDULED' | 'MIN_DATA_THRESHOLD';

export type EntityType = 'PRODUCT' | 'SKU' | 'CUSTOMER' | 'ORDER';

export interface ModelMetrics {
  train: Record<string, number>;
  validation: Record<string, number>;
  test: Record<string, number>;
}

export interface RegisteredModelRecord {
  id: string;
  tenantId: string;
  modelType: ModelType;
  version: string;
  status: ModelStatus;
  algorithm: string;
  hyperparameters: Record<string, unknown>;
  featureVersion: string;
  trainingDatasetId: string;
  dataSourceType: DataSourceType;
  isSynthetic: boolean;
  predictionHorizon: string;
  metrics: ModelMetrics;
  artifactPath?: string | null | undefined;
  isActive: boolean;
  rejectionReason?: string | null | undefined;
  createdAt: string;
  evaluatedAt?: string | null | undefined;
  approvedAt?: string | null | undefined;
  retiredAt?: string | null | undefined;
}

export interface TrainingJobRecord {
  id: string;
  tenantId: string;
  modelType: ModelType;
  triggerType: TriggerType;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  dataSourceType: DataSourceType;
  sampleCount: number;
  modelId?: string | null | undefined;
  errorMessage?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  startedAt: string;
  completedAt?: string | null | undefined;
}

export interface DerivedPredictionRecord {
  id: string;
  scopeKey: string;
  tenantId: string;
  modelId: string;
  modelVersion: string;
  modelType: ModelType;
  entityType: EntityType;
  entityId: string;
  predictionValue: number;
  probability?: number | null | undefined;
  confidence?: number | null | undefined;
  horizon: string;
  featureVersion: string;
  dataSourceType: DataSourceType;
  isSynthetic: boolean;
  provenance: Record<string, unknown>;
  predictedAt: string;
  expiresAt?: string | null | undefined;
}

export interface RetrainingPolicyRecord {
  id: string;
  tenantId: string;
  modelType: ModelType;
  minNewOrdersThreshold: number;
  lastTrainedOrderCount: number;
  lastTrainedAt?: string | null | undefined;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrainModelInputDto {
  tenantId: string;
  modelType: ModelType;
  version?: string | undefined;
  algorithm?: string | undefined;
  hyperparameters?: Record<string, unknown> | undefined;
  predictionHorizon?: string | undefined;
  triggerType?: TriggerType | undefined;
  maxAcceptableRmse?: number | undefined;
  minAcceptableAccuracy?: number | undefined;
}

export interface PredictionResultDto {
  tenantId: string;
  modelType: ModelType;
  modelVersion: string;
  entityType: EntityType;
  entityId: string;
  predictedValue: number;
  probability?: number | null | undefined;
  confidence?: number | null | undefined;
  horizon: string;
  dataSourceType: DataSourceType;
  isSynthetic: boolean;
  predictedAt: string;
}

/**
 * Pluggable Store Abstraction for Predictive ML.
 * Decouples ML domain logic from database infrastructure.
 */
export interface IMlStore {
  // Model Registry
  saveModel(model: RegisteredModelRecord): Promise<void>;
  getModelById(tenantId: string, modelId: string): Promise<RegisteredModelRecord | null>;
  getActiveModel(tenantId: string, modelType: ModelType): Promise<RegisteredModelRecord | null>;
  listModels(tenantId: string, modelType?: ModelType): Promise<RegisteredModelRecord[]>;
  setActiveModel(tenantId: string, modelId: string, modelType: ModelType): Promise<void>;
  updateModelStatus(
    tenantId: string,
    modelId: string,
    status: ModelStatus,
    rejectionReason?: string,
  ): Promise<void>;

  // Training Jobs
  createTrainingJob(job: TrainingJobRecord): Promise<void>;
  updateTrainingJob(
    jobId: string,
    updates: Partial<
      Pick<
        TrainingJobRecord,
        'status' | 'modelId' | 'errorMessage' | 'completedAt' | 'sampleCount' | 'dataSourceType'
      >
    >,
  ): Promise<void>;
  getTrainingJobById(tenantId: string, jobId: string): Promise<TrainingJobRecord | null>;
  getLatestRunningJob(tenantId: string, modelType: ModelType): Promise<TrainingJobRecord | null>;
  claimNextPendingJob(): Promise<TrainingJobRecord | null>;
  recoverStaleJobs(staleThresholdMs: number): Promise<number>;
  listTrainingJobs(tenantId: string, modelType?: ModelType): Promise<TrainingJobRecord[]>;

  // Predictions
  savePredictions(predictions: DerivedPredictionRecord[]): Promise<void>;
  getPrediction(
    tenantId: string,
    modelType: ModelType,
    entityType: EntityType,
    entityId: string,
  ): Promise<DerivedPredictionRecord | null>;
  listPredictions(
    tenantId: string,
    filter?: {
      modelType?: ModelType | undefined;
      entityType?: EntityType | undefined;
      entityId?: string | undefined;
    },
  ): Promise<DerivedPredictionRecord[]>;

  // Retraining Policies
  getRetrainingPolicy(
    tenantId: string,
    modelType: ModelType,
  ): Promise<RetrainingPolicyRecord | null>;
  listAllEnabledPolicies(): Promise<RetrainingPolicyRecord[]>;
  saveRetrainingPolicy(policy: RetrainingPolicyRecord): Promise<void>;
  updateRetrainingPolicyStats(
    tenantId: string,
    modelType: ModelType,
    lastTrainedOrderCount: number,
    lastTrainedAt: string,
  ): Promise<void>;
}

/**
 * Optional typed ML signals reader consumed by recommendations or external callers.
 */
export interface IMlSignalReader {
  getDemandForecast(tenantId: string, productId: string): Promise<number | null>;
  getStockoutRisk(tenantId: string, sku: string): Promise<number | null>;
  getPurchasePropensity(tenantId: string, customerId: string): Promise<number | null>;
}
