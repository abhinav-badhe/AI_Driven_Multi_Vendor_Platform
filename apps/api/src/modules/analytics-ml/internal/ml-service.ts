import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { ForbiddenError, ValidationError, NotFoundError, ConflictError } from '../../../errors/app-error.js';
import type { IAnalyticsMlFeatureReader } from '../../analytics/index.js';
import type {
  DerivedPredictionRecord,
  IMlSignalReader,
  IMlStore,
  ModelType,
  RegisteredModelRecord,
  RetrainingPolicyRecord,
  TrainModelInputDto,
  TrainingJobRecord,
} from './ml-models.js';
import type { PythonRunner } from './python-runner.js';

export class MlService implements IMlSignalReader {
  private retrainingTimer: NodeJS.Timeout | null = null;
  private isProcessingWorker = false;

  constructor(
    private readonly store: IMlStore,
    private readonly featureReader: IAnalyticsMlFeatureReader,
    private readonly logger: Logger,
    private readonly pythonRunner: PythonRunner,
  ) {}

  private assertTenantAccess(actor: AuthorizedActor, tenantId: string): void {
    if (actor.role === 'CUSTOMER') {
      throw new ForbiddenError('Customers cannot access ML management operations');
    }
    if (actor.role === 'MERCHANT' && actor.tenantId !== tenantId) {
      throw new ForbiddenError(`Merchant ${actor.tenantId} cannot access tenant ${tenantId} ML data`);
    }
  }

  /**
   * Enqueues a durable ML training job with status PENDING and immediately returns without waiting for Python.
   */
  async enqueueTrainingJob(
    actor: AuthorizedActor,
    input: TrainModelInputDto,
  ): Promise<TrainingJobRecord> {
    const tenantId = input.tenantId?.trim();
    if (!tenantId) throw new ValidationError('tenantId is required');
    this.assertTenantAccess(actor, tenantId);

    const modelType = input.modelType;
    if (!modelType) throw new ValidationError('modelType is required');

    // Prevent concurrent duplicate training jobs for the same model and tenant
    const existingRunning = await this.store.getLatestRunningJob(tenantId, modelType);
    if (existingRunning) {
      throw new ConflictError(
        `A training job (${existingRunning.id}) is already ${existingRunning.status} for ${tenantId} ${modelType}`,
      );
    }

    const jobId = `job-${randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    const jobRecord: TrainingJobRecord = {
      id: jobId,
      tenantId,
      modelType,
      triggerType: input.triggerType ?? 'MANUAL',
      status: 'PENDING',
      dataSourceType: 'REAL',
      sampleCount: 0,
      config: {
        version: input.version,
        algorithm: input.algorithm,
        hyperparameters: input.hyperparameters ?? {},
        predictionHorizon: input.predictionHorizon,
        maxAcceptableRmse: input.maxAcceptableRmse,
        minAcceptableAccuracy: input.minAcceptableAccuracy,
      },
      startedAt: nowIso,
    };

    await this.store.createTrainingJob(jobRecord);

    // Asynchronously kick off the background worker without blocking this caller
    this.triggerBackgroundWorker();

    return jobRecord;
  }

  /**
   * Backward-compatible alias for enqueueTrainingJob.
   */
  async trainModel(
    actor: AuthorizedActor,
    input: TrainModelInputDto,
  ): Promise<TrainingJobRecord> {
    return this.enqueueTrainingJob(actor, input);
  }

  /**
   * Triggers the background worker to drain pending jobs asynchronously.
   */
  private triggerBackgroundWorker(): void {
    setImmediate(async () => {
      if (this.isProcessingWorker) return;
      this.isProcessingWorker = true;
      try {
        await this.processAllPendingJobs();
      } catch (err) {
        this.logger.error('Background ML worker run encountered an error', { error: String(err) });
      } finally {
        this.isProcessingWorker = false;
      }
    });
  }

  /**
   * Claims and processes the next pending training job from the queue.
   */
  async processNextPendingJob(): Promise<TrainingJobRecord | null> {
    const job = await this.store.claimNextPendingJob();
    if (!job) return null;

    return this.executeJob(job);
  }

  /**
   * Drains all pending training jobs.
   */
  async processAllPendingJobs(): Promise<TrainingJobRecord[]> {
    const completed: TrainingJobRecord[] = [];
    while (true) {
      const job = await this.processNextPendingJob();
      if (!job) break;
      completed.push(job);
    }
    return completed;
  }

  /**
   * Waits for a training job to reach a terminal status (COMPLETED or FAILED).
   */
  async waitForJob(tenantId: string, jobId: string, timeoutMs = 20000): Promise<TrainingJobRecord | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await this.store.getTrainingJobById(tenantId, jobId);
      if (job && (job.status === 'COMPLETED' || job.status === 'FAILED')) {
        return job;
      }
      if (job && job.status === 'PENDING') {
        await this.processNextPendingJob();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return this.store.getTrainingJobById(tenantId, jobId);
  }

  /**
   * Executes Python training pipeline for a claimed training job.
   */
  private async executeJob(job: TrainingJobRecord): Promise<TrainingJobRecord> {
    const { id: jobId, tenantId, modelType, config } = job;
    const nowIso = new Date().toISOString();

    try {
      let rawRecords: unknown[] = [];
      if (modelType === 'DEMAND_FORECASTING') {
        rawRecords = await this.featureReader.getProductDailyDemandHistory(tenantId, 60);
      } else if (modelType === 'STOCKOUT_RISK') {
        rawRecords = await this.featureReader.getInventoryVelocitySignals(tenantId);
      } else if (modelType === 'PURCHASE_PROPENSITY') {
        rawRecords = await this.featureReader.getCustomerActivitySignals(tenantId);
      } else if (modelType === 'ANOMALY_DETECTION') {
        rawRecords = await this.featureReader.getOrderAnomalySignals(tenantId);
      }

      const version = (config?.version as string | undefined) ?? `v1.${Date.now()}`;
      const trainConfig = {
        tenantId,
        modelType,
        version,
        records: rawRecords,
        hyperparameters: (config?.hyperparameters as Record<string, unknown> | undefined) ?? {},
        algorithm: config?.algorithm as string | undefined,
        seed: 42,
        horizon: (config?.predictionHorizon as string | undefined) ?? (modelType === 'PURCHASE_PROPENSITY' ? '14d' : '7d'),
        maxAcceptableRmse: (config?.maxAcceptableRmse as number | undefined) ?? 100.0,
        minAcceptableAccuracy: (config?.minAcceptableAccuracy as number | undefined) ?? 0.50,
      };

      const trainResult = await this.pythonRunner.runTraining(trainConfig);

      if (!trainResult.success || trainResult.status === 'FAILED') {
        this.logger.error('Model training execution failed', {
          jobId,
          tenantId,
          modelType,
          error: trainResult.error ?? 'Unknown error',
        });
        await this.store.updateTrainingJob(jobId, {
          status: 'FAILED',
          errorMessage: trainResult.error ?? 'Model training failed during execution',
          completedAt: new Date().toISOString(),
        });
        const updated = await this.store.getTrainingJobById(tenantId, jobId);
        return updated ?? { ...job, status: 'FAILED', errorMessage: trainResult.error ?? null };
      }

      const modelId = trainResult.modelId ?? `mdl-${randomUUID().slice(0, 12)}`;
      const dataSourceType = trainResult.dataSourceType ?? 'BOOTSTRAP';
      const isApproved = trainResult.status === 'APPROVED';

      const modelRecord: RegisteredModelRecord = {
        id: modelId,
        tenantId,
        modelType,
        version,
        status: isApproved ? 'APPROVED' : 'REJECTED',
        algorithm: trainResult.algorithm ?? 'DefaultModel',
        hyperparameters: trainResult.hyperparameters ?? {},
        featureVersion: trainResult.featureVersion ?? 'v1',
        trainingDatasetId: trainResult.trainingDatasetId ?? `ds-${randomUUID().slice(0, 8)}`,
        dataSourceType,
        isSynthetic: dataSourceType === 'BOOTSTRAP',
        predictionHorizon: trainResult.predictionHorizon ?? '7d',
        metrics: trainResult.metrics ?? { train: {}, validation: {}, test: {} },
        artifactPath: trainResult.artifactPath ?? null,
        isActive: false, // will activate via setActiveModel if approved
        rejectionReason: trainResult.rejectionReason ?? null,
        createdAt: nowIso,
        evaluatedAt: trainResult.evaluatedAt ?? nowIso,
        approvedAt: isApproved ? nowIso : null,
      };

      await this.store.saveModel(modelRecord);

      if (isApproved) {
        // Atomic promotion: retires any previously active model and marks this model active
        await this.store.setActiveModel(tenantId, modelId, modelType);
        modelRecord.isActive = true;

        // Generate baseline predictions for active entities
        await this.generatePredictions(tenantId, modelType).catch((err) => {
          this.logger.warn('Initial prediction generation encountered error', { error: String(err) });
        });
      } else {
        this.logger.warn('Candidate model rejected by acceptance evaluation criteria', {
          jobId,
          tenantId,
          modelType,
          modelId,
          rejectionReason: trainResult.rejectionReason,
        });
      }

      await this.store.updateTrainingJob(jobId, {
        status: isApproved ? 'COMPLETED' : 'FAILED',
        modelId,
        sampleCount: trainResult.sampleCount ?? rawRecords.length,
        dataSourceType,
        errorMessage: isApproved ? null : (trainResult.rejectionReason ?? 'Model rejected during evaluation'),
        completedAt: new Date().toISOString(),
      });

      const updated = await this.store.getTrainingJobById(tenantId, jobId);
      return updated ?? {
        ...job,
        status: isApproved ? 'COMPLETED' : 'FAILED',
        modelId,
        sampleCount: trainResult.sampleCount ?? rawRecords.length,
        dataSourceType,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('Unexpected error during model training job execution', { jobId, error: msg });
      await this.store.updateTrainingJob(jobId, {
        status: 'FAILED',
        errorMessage: msg,
        completedAt: new Date().toISOString(),
      });
      const updated = await this.store.getTrainingJobById(tenantId, jobId);
      return updated ?? { ...job, status: 'FAILED', errorMessage: msg };
    }
  }

  /**
   * Recovers jobs that were left in PENDING or RUNNING status past the stale threshold.
   */
  async recoverStaleJobs(staleThresholdMs = 300000): Promise<number> {
    return this.store.recoverStaleJobs(staleThresholdMs);
  }

  // --- Automatic Retraining Lifecycle ---

  /**
   * Starts background scheduler to periodically evaluate retraining policies across tenants.
   */
  startRetrainingScheduler(intervalMs = 60000): void {
    if (this.retrainingTimer) return;
    this.retrainingTimer = setInterval(() => {
      this.evaluateAllRetrainingPolicies().catch((err) => {
        this.logger.error('Error during automatic retraining scheduler execution', { error: String(err) });
      });
    }, intervalMs);
    if (this.retrainingTimer.unref) {
      this.retrainingTimer.unref();
    }
  }

  /**
   * Stops background retraining scheduler.
   */
  stopRetrainingScheduler(): void {
    if (this.retrainingTimer) {
      clearInterval(this.retrainingTimer);
      this.retrainingTimer = null;
    }
  }

  /**
   * Evaluates all enabled retraining policies across all tenants.
   */
  async evaluateAllRetrainingPolicies(): Promise<
    Array<{ tenantId: string; modelType: ModelType; retrained: boolean; jobId?: string; reason: string }>
  > {
    const policies = await this.store.listAllEnabledPolicies();
    const results: Array<{ tenantId: string; modelType: ModelType; retrained: boolean; jobId?: string; reason: string }> = [];

    for (const policy of policies) {
      try {
        const existingRunning = await this.store.getLatestRunningJob(policy.tenantId, policy.modelType);
        if (existingRunning) {
          results.push({ tenantId: policy.tenantId, modelType: policy.modelType, retrained: false, reason: 'JOB_ALREADY_ACTIVE' });
          continue;
        }

        const demandFacts = await this.featureReader.getProductDailyDemandHistory(policy.tenantId, 30);
        const currentOrderCount = demandFacts.reduce((sum, d) => sum + d.orderCount, 0);
        const diff = currentOrderCount - policy.lastTrainedOrderCount;

        if (diff >= policy.minNewOrdersThreshold || currentOrderCount === 0) {
          const nowIso = new Date().toISOString();
          const job = await this.enqueueTrainingJob(
            { role: 'MERCHANT', tenantId: policy.tenantId, userId: 'system-scheduler' },
            {
              tenantId: policy.tenantId,
              modelType: policy.modelType,
              triggerType: 'MIN_DATA_THRESHOLD',
            },
          );

          await this.store.updateRetrainingPolicyStats(
            policy.tenantId,
            policy.modelType,
            currentOrderCount,
            nowIso,
          );

          results.push({ tenantId: policy.tenantId, modelType: policy.modelType, retrained: true, jobId: job.id, reason: `THRESHOLD_MET: +${diff} orders` });
        } else {
          results.push({ tenantId: policy.tenantId, modelType: policy.modelType, retrained: false, reason: `BELOW_THRESHOLD: +${diff}/${policy.minNewOrdersThreshold} orders` });
        }
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          results.push({ tenantId: policy.tenantId, modelType: policy.modelType, retrained: false, reason: 'JOB_ALREADY_ACTIVE' });
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('Failed evaluating retraining policy for tenant', { tenantId: policy.tenantId, modelType: policy.modelType, error: msg });
      }
    }
    return results;
  }

  /**
   * Evaluates retraining policy for a specific tenant and model type.
   */
  async retrainIfEligible(
    actor: AuthorizedActor,
    tenantId: string,
    modelType: ModelType,
  ): Promise<{ retrained: boolean; jobId?: string; reason: string }> {
    this.assertTenantAccess(actor, tenantId);

    const policy = await this.store.getRetrainingPolicy(tenantId, modelType);
    if (policy && !policy.enabled) {
      return { retrained: false, reason: 'POLICY_DISABLED' };
    }

    const minThreshold = policy?.minNewOrdersThreshold ?? 10;
    const demandFacts = await this.featureReader.getProductDailyDemandHistory(tenantId, 30);
    const currentOrderCount = demandFacts.reduce((sum, d) => sum + d.orderCount, 0);

    const lastCount = policy?.lastTrainedOrderCount ?? 0;
    const diff = currentOrderCount - lastCount;

    if (diff >= minThreshold || currentOrderCount === 0) {
      try {
        const job = await this.enqueueTrainingJob(actor, {
          tenantId,
          modelType,
          triggerType: 'MIN_DATA_THRESHOLD',
        });

        await this.store.updateRetrainingPolicyStats(
          tenantId,
          modelType,
          currentOrderCount,
          new Date().toISOString(),
        );

        return { retrained: true, jobId: job.id, reason: `THRESHOLD_MET: +${diff} orders` };
      } catch (err) {
        if (err instanceof ConflictError) {
          return { retrained: false, reason: 'JOB_ALREADY_ACTIVE' };
        }
        throw err;
      }
    }

    return { retrained: false, reason: `BELOW_THRESHOLD: +${diff}/${minThreshold} orders` };
  }

  // --- Model Registry Operations ---

  /**
   * Rollback active model to a previously approved version.
   */
  async rollbackModel(
    actor: AuthorizedActor,
    tenantId: string,
    modelId: string,
  ): Promise<RegisteredModelRecord> {
    this.assertTenantAccess(actor, tenantId);

    const model = await this.store.getModelById(tenantId, modelId);
    if (!model) {
      throw new NotFoundError(`Model ${modelId} not found for tenant ${tenantId}`);
    }

    if (model.status !== 'APPROVED' && model.status !== 'RETIRED') {
      throw new ValidationError(`Cannot rollback to model with status '${model.status}'`);
    }

    await this.store.setActiveModel(tenantId, modelId, model.modelType);
    const updated = await this.store.getModelById(tenantId, modelId);
    return updated!;
  }

  async getActiveModel(
    actor: AuthorizedActor,
    tenantId: string,
    modelType: ModelType,
  ): Promise<RegisteredModelRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getActiveModel(tenantId, modelType);
  }

  async listModels(
    actor: AuthorizedActor,
    tenantId: string,
    modelType?: ModelType,
  ): Promise<RegisteredModelRecord[]> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.listModels(tenantId, modelType);
  }

  async getModelById(
    actor: AuthorizedActor,
    tenantId: string,
    modelId: string,
  ): Promise<RegisteredModelRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getModelById(tenantId, modelId);
  }

  async getTrainingJobById(
    actor: AuthorizedActor,
    tenantId: string,
    jobId: string,
  ): Promise<TrainingJobRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getTrainingJobById(tenantId, jobId);
  }

  async listTrainingJobs(
    actor: AuthorizedActor,
    tenantId: string,
    modelType?: ModelType,
  ): Promise<TrainingJobRecord[]> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.listTrainingJobs(tenantId, modelType);
  }

  /**
   * Generates derived predictions for active entities and stores them idempotently.
   * If model artifact is missing or corrupted, fails safely without affecting callers.
   */
  async generatePredictions(tenantId: string, modelType: ModelType): Promise<{ count: number }> {
    try {
      const activeModel = await this.store.getActiveModel(tenantId, modelType);
      if (!activeModel || !activeModel.artifactPath) {
        return { count: 0 };
      }

      const featureVectors: Array<{ entityId: string; featureVector: number[] }> = [];

      if (modelType === 'DEMAND_FORECASTING') {
        const dailyHistory = await this.featureReader.getProductDailyDemandHistory(tenantId, 60);
        const byProduct = new Map<string, typeof dailyHistory>();
        for (const item of dailyHistory) {
          const arr = byProduct.get(item.productId) ?? [];
          arr.push(item);
          byProduct.set(item.productId, arr);
        }

        for (const [productId, records] of byProduct.entries()) {
          const sorted = records.sort((a, b) => a.date.localeCompare(b.date));
          const last = sorted[sorted.length - 1];
          const lag1 = last?.unitsSold ?? 5.0;
          const lag7 = sorted[Math.max(0, sorted.length - 7)]?.unitsSold ?? lag1;
          const recent = sorted.slice(-7);
          const mean7 = recent.reduce((s, r) => s + r.unitsSold, 0) / Math.max(1, recent.length);
          const mean14 = sorted.slice(-14).reduce((s, r) => s + r.unitsSold, 0) / Math.max(1, Math.min(14, sorted.length));
          const price = last?.price ?? 100.0;
          const dow = new Date().getDay();
          const isWeekend = dow === 0 || dow === 6 ? 1.0 : 0.0;

          featureVectors.push({
            entityId: productId,
            featureVector: [lag1, lag7, mean7, mean14, 1.5, price, dow, isWeekend],
          });
        }
      } else if (modelType === 'STOCKOUT_RISK') {
        const velocities = await this.featureReader.getInventoryVelocitySignals(tenantId);
        for (const item of velocities) {
          const onHand = item.currentOnHand;
          const reserved = item.reservedQuantity;
          const v7 = item.velocity7d;
          const v14 = item.velocity14d;
          const available = Math.max(0, onHand - reserved);
          const dailyRate = Math.max(0.1, v7 / 7.0);
          const daysOfSupply = available / dailyRate;
          const runoutRate = (dailyRate * 7.0) / Math.max(1.0, available);

          featureVectors.push({
            entityId: item.sku || item.productId,
            featureVector: [onHand, reserved, v7, v14, daysOfSupply, runoutRate, item.leadTimeDays],
          });
        }
      } else if (modelType === 'PURCHASE_PROPENSITY') {
        const activities = await this.featureReader.getCustomerActivitySignals(tenantId);
        for (const cust of activities) {
          const aov = cust.monetaryTotal / Math.max(1, cust.totalOrders);
          featureVectors.push({
            entityId: cust.customerId,
            featureVector: [
              cust.recencyDays,
              cust.frequency30d,
              cust.frequency90d,
              cust.totalOrders,
              cust.monetaryTotal,
              aov,
            ],
          });
        }
      } else if (modelType === 'ANOMALY_DETECTION') {
        const orders = await this.featureReader.getOrderAnomalySignals(tenantId);
        for (const ord of orders) {
          const total = Math.max(1, ord.totalAmount);
          const qty = Math.max(1, ord.totalQuantity);
          featureVectors.push({
            entityId: ord.orderId,
            featureVector: [
              Math.log(total),
              ord.lineCount,
              qty,
              total / qty,
              ord.hourOfDay,
              ord.hourOfDay < 6 || ord.hourOfDay >= 23 ? 1 : 0,
            ],
          });
        }
      }

      if (featureVectors.length === 0) return { count: 0 };

      const predResult = await this.pythonRunner.runPrediction({
        modelType,
        artifactPath: activeModel.artifactPath,
        features: featureVectors,
      });

      if (!predResult.success || !predResult.predictions) {
        return { count: 0 };
      }

      const entityType =
        modelType === 'DEMAND_FORECASTING'
          ? 'PRODUCT'
          : modelType === 'STOCKOUT_RISK'
            ? 'SKU'
            : modelType === 'ANOMALY_DETECTION'
              ? 'ORDER'
              : 'CUSTOMER';

      const horizon = activeModel.predictionHorizon;
      const nowIso = new Date().toISOString();
      const recordsToSave: DerivedPredictionRecord[] = [];

      for (const pred of predResult.predictions) {
        // Idempotency scopeKey ensures repeated runs safely upsert without duplicate prediction records
        const scopeKey = `${tenantId}:${modelType}:${entityType}:${pred.entityId}:${activeModel.version}`;
        recordsToSave.push({
          id: `prd-${randomUUID().slice(0, 12)}`,
          scopeKey,
          tenantId,
          modelId: activeModel.id,
          modelVersion: activeModel.version,
          modelType,
          entityType,
          entityId: pred.entityId,
          predictionValue: pred.predictionValue,
          probability: pred.probability ?? null,
          confidence: pred.confidence ?? null,
          horizon,
          featureVersion: activeModel.featureVersion,
          dataSourceType: activeModel.dataSourceType,
          isSynthetic: activeModel.dataSourceType === 'BOOTSTRAP',
          provenance: {
            algorithm: activeModel.algorithm,
            modelStatus: activeModel.status,
            isSynthetic: activeModel.dataSourceType === 'BOOTSTRAP',
            generatedAt: nowIso,
          },
          predictedAt: nowIso,
        });
      }

      await this.store.savePredictions(recordsToSave);
      return { count: recordsToSave.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('Safe prediction generation caught error and returned empty count', { error: msg });
      return { count: 0 };
    }
  }

  // --- Prediction Read Queries ---

  async getDemandPrediction(
    actor: AuthorizedActor,
    tenantId: string,
    productId: string,
  ): Promise<DerivedPredictionRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getPrediction(tenantId, 'DEMAND_FORECASTING', 'PRODUCT', productId);
  }

  async getStockoutPrediction(
    actor: AuthorizedActor,
    tenantId: string,
    sku: string,
  ): Promise<DerivedPredictionRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getPrediction(tenantId, 'STOCKOUT_RISK', 'SKU', sku);
  }

  async getPropensityPrediction(
    actor: AuthorizedActor,
    tenantId: string,
    customerId: string,
  ): Promise<DerivedPredictionRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getPrediction(tenantId, 'PURCHASE_PROPENSITY', 'CUSTOMER', customerId);
  }

  async getAnomalyPrediction(
    actor: AuthorizedActor,
    tenantId: string,
    orderId: string,
  ): Promise<DerivedPredictionRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getPrediction(tenantId, 'ANOMALY_DETECTION', 'ORDER', orderId);
  }

  async listPredictions(
    actor: AuthorizedActor,
    tenantId: string,
    filter?: { modelType?: ModelType | undefined; entityType?: 'PRODUCT' | 'SKU' | 'CUSTOMER' | 'ORDER' | undefined; entityId?: string | undefined },
  ): Promise<DerivedPredictionRecord[]> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.listPredictions(tenantId, filter);
  }

  async getRetrainingPolicy(
    actor: AuthorizedActor,
    tenantId: string,
    modelType: ModelType,
  ): Promise<RetrainingPolicyRecord | null> {
    this.assertTenantAccess(actor, tenantId);
    return this.store.getRetrainingPolicy(tenantId, modelType);
  }

  async saveRetrainingPolicy(
    actor: AuthorizedActor,
    tenantId: string,
    modelType: ModelType,
    updates: { minNewOrdersThreshold?: number; enabled?: boolean },
  ): Promise<RetrainingPolicyRecord> {
    this.assertTenantAccess(actor, tenantId);
    let policy = await this.store.getRetrainingPolicy(tenantId, modelType);
    const now = new Date().toISOString();
    if (!policy) {
      policy = {
        id: `${tenantId}:${modelType}`,
        tenantId,
        modelType,
        minNewOrdersThreshold: updates.minNewOrdersThreshold ?? 10,
        lastTrainedOrderCount: 0,
        enabled: updates.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (updates.minNewOrdersThreshold !== undefined) {
        policy.minNewOrdersThreshold = updates.minNewOrdersThreshold;
      }
      if (updates.enabled !== undefined) {
        policy.enabled = updates.enabled;
      }
      policy.updatedAt = now;
    }
    await this.store.saveRetrainingPolicy(policy);
    return policy;
  }

  // --- IMlSignalReader implementation (Optional signals for recommendations) ---

  async getDemandForecast(tenantId: string, productId: string): Promise<number | null> {
    const pred = await this.store.getPrediction(tenantId, 'DEMAND_FORECASTING', 'PRODUCT', productId);
    return pred ? pred.predictionValue : null;
  }

  async getStockoutRisk(tenantId: string, sku: string): Promise<number | null> {
    const pred = await this.store.getPrediction(tenantId, 'STOCKOUT_RISK', 'SKU', sku);
    return pred && pred.probability !== null && pred.probability !== undefined
      ? pred.probability
      : null;
  }

  async getPurchasePropensity(tenantId: string, customerId: string): Promise<number | null> {
    const pred = await this.store.getPrediction(tenantId, 'PURCHASE_PROPENSITY', 'CUSTOMER', customerId);
    return pred && pred.probability !== null && pred.probability !== undefined
      ? pred.probability
      : null;
  }
}
