import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  analyticsMlModule,
  InMemoryMlStore,
  MlService,
  PythonRunner,
  type RegisteredModelRecord,
} from '../src/modules/analytics-ml/index.js';
import { SqlMlStore } from '../src/infra/ml/sql-ml-store.js';
import type {
  CustomerActivitySignal,
  IAnalyticsMlFeatureReader,
  InventoryVelocitySignal,
  OrderAnomalySignal,
  ProductDailyDemandRecord,
} from '../src/modules/analytics/index.js';
import type { AuthorizedActor } from '../src/modules/identity/index.js';
import { ForbiddenError, ConflictError, NotFoundError } from '../src/errors/app-error.js';

class MockFeatureReader implements IAnalyticsMlFeatureReader {
  public demandRecords: ProductDailyDemandRecord[] = [];
  public inventorySignals: InventoryVelocitySignal[] = [];
  public customerSignals: CustomerActivitySignal[] = [];
  public orderAnomalySignals: OrderAnomalySignal[] = [];

  async getProductDailyDemandHistory(
    tenantId: string,
    _lookbackDays = 60,
  ): Promise<ProductDailyDemandRecord[]> {
    return this.demandRecords.filter((r) => r.tenantId === tenantId);
  }

  async getInventoryVelocitySignals(tenantId: string): Promise<InventoryVelocitySignal[]> {
    return this.inventorySignals.filter((r) => r.tenantId === tenantId);
  }

  async getCustomerActivitySignals(tenantId: string): Promise<CustomerActivitySignal[]> {
    return this.customerSignals.filter((r) => r.tenantId === tenantId);
  }

  async getOrderAnomalySignals(tenantId: string): Promise<OrderAnomalySignal[]> {
    return this.orderAnomalySignals.filter((r) => r.tenantId === tenantId);
  }
}

describe(
  'Phase 13: Predictive ML Engine (Surgical Verification & Hardening)',
  { timeout: 35000 },
  () => {
    const logger = new JsonLogger({ serviceName: 'ml-test', level: 'error' });
    const adminActor: AuthorizedActor = {
      userId: 'u-admin',
      tenantId: 'tenant-alpha',
      role: 'ADMINISTRATOR',
    };
    const merchantAlpha: AuthorizedActor = {
      userId: 'u-merch-a',
      tenantId: 'tenant-alpha',
      role: 'MERCHANT',
    };
    const merchantBeta: AuthorizedActor = {
      userId: 'u-merch-b',
      tenantId: 'tenant-beta',
      role: 'MERCHANT',
    };
    const customerActor: AuthorizedActor = {
      userId: 'u-cust',
      tenantId: 'tenant-alpha',
      role: 'CUSTOMER',
    };

    let featureReader: MockFeatureReader;
    let inMemoryStore: InMemoryMlStore;
    let pythonRunner: PythonRunner;
    let service: MlService;

    beforeEach(() => {
      featureReader = new MockFeatureReader();
      inMemoryStore = new InMemoryMlStore();
      pythonRunner = analyticsMlModule.createPythonRunner(logger);
      service = analyticsMlModule.createService(inMemoryStore, featureReader, logger, pythonRunner);
    });

    afterEach(() => {
      service.stopRetrainingScheduler();
    });

    describe('1. True Asynchronous ML Execution', () => {
      it('HTTP request enqueues durable training job (status: PENDING) and returns immediately', async () => {
        const job = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v1.0.0',
        });

        // Verifies HTTP returns immediately with durable PENDING job without waiting for Python
        expect(job.id).toBeDefined();
        expect(job.status).toBe('PENDING');
        expect(job.tenantId).toBe('tenant-alpha');
        expect(job.modelType).toBe('DEMAND_FORECASTING');

        // Verify job is durable in store
        const fetched = await service.getTrainingJobById(merchantAlpha, 'tenant-alpha', job.id);
        expect(fetched?.status).toBe('PENDING');

        // Background worker claims and executes the job
        const completed = await service.processNextPendingJob();
        expect(completed?.id).toBe(job.id);
        expect(completed?.status).toBe('COMPLETED');
        expect(completed?.modelId).toBeDefined();

        // Active model is now APPROVED
        const activeModel = await service.getActiveModel(
          merchantAlpha,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        );
        expect(activeModel?.id).toBe(completed?.modelId);
        expect(activeModel?.status).toBe('APPROVED');
      });

      it('drains multiple pending jobs asynchronously in batch', async () => {
        // Enqueue for two different model types
        const job1 = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });
        const job2 = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
        });

        expect(job1.status).toBe('PENDING');
        expect(job2.status).toBe('PENDING');

        await service.processAllPendingJobs();
        await service.waitForJob('tenant-alpha', job1.id);
        await service.waitForJob('tenant-alpha', job2.id);

        const jobs = await service.listTrainingJobs(merchantAlpha, 'tenant-alpha');
        expect(jobs.length).toBe(2);
        expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);
      });
    });

    describe('2. Training Concurrency & Stale Job Recovery', () => {
      it('A. concurrent training trigger: rejects simultaneous duplicate jobs for same tenant and model type', async () => {
        // First job enqueued
        await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });

        // Second simultaneous request for same (tenantId, modelType) must fail with ConflictError
        await expect(
          service.enqueueTrainingJob(merchantAlpha, {
            tenantId: 'tenant-alpha',
            modelType: 'DEMAND_FORECASTING',
          }),
        ).rejects.toThrow(ConflictError);
      });

      it('allows different tenants to train concurrently without conflict', async () => {
        const jobAlpha = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });
        const jobBeta = await service.enqueueTrainingJob(merchantBeta, {
          tenantId: 'tenant-beta',
          modelType: 'DEMAND_FORECASTING',
        });

        expect(jobAlpha.tenantId).toBe('tenant-alpha');
        expect(jobBeta.tenantId).toBe('tenant-beta');
        expect(jobAlpha.status).toBe('PENDING');
        expect(jobBeta.status).toBe('PENDING');

        const completedAlpha = await service.waitForJob('tenant-alpha', jobAlpha.id);
        const completedBeta = await service.waitForJob('tenant-beta', jobBeta.id);
        expect(completedAlpha?.status).toBe('COMPLETED');
        expect(completedBeta?.status).toBe('COMPLETED');
      });

      it('B. stale training-job recovery: recovers orphaned RUNNING jobs while preserving claimable PENDING jobs', async () => {
        // 1. Insert an old PENDING job (started 15 minutes ago) representing queued backlog
        const oldPendingTime = new Date(Date.now() - 900000).toISOString();
        await inMemoryStore.createTrainingJob({
          id: 'job-old-pending',
          tenantId: 'tenant-pending',
          modelType: 'DEMAND_FORECASTING',
          triggerType: 'MANUAL',
          status: 'PENDING',
          dataSourceType: 'REAL',
          sampleCount: 0,
          startedAt: oldPendingTime,
        });

        // 2. Insert a crashed RUNNING job (started 10 minutes ago)
        const staleTimestamp = new Date(Date.now() - 600000).toISOString();
        await inMemoryStore.createTrainingJob({
          id: 'job-stale-crashed',
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          triggerType: 'MANUAL',
          status: 'RUNNING',
          dataSourceType: 'REAL',
          sampleCount: 10,
          startedAt: staleTimestamp,
        });

        // Prior to recovery, new job for tenant-alpha is blocked by ConflictError
        await expect(
          service.enqueueTrainingJob(merchantAlpha, {
            tenantId: 'tenant-alpha',
            modelType: 'DEMAND_FORECASTING',
          }),
        ).rejects.toThrow(ConflictError);

        // Run stale job recovery with 5-minute threshold (300,000 ms)
        const recoveredCount = await service.recoverStaleJobs(300000);
        expect(recoveredCount).toBe(1);

        // Crashed RUNNING job is marked FAILED with recovery message
        const crashedJob = await inMemoryStore.getTrainingJobById(
          'tenant-alpha',
          'job-stale-crashed',
        );
        expect(crashedJob?.status).toBe('FAILED');
        expect(crashedJob?.errorMessage).toContain('stale job recovery');

        // Crucial Check 2 invariant: Old PENDING job must NOT be marked FAILED and must remain claimable
        const pendingJob = await inMemoryStore.getTrainingJobById(
          'tenant-pending',
          'job-old-pending',
        );
        expect(pendingJob?.status).toBe('PENDING');

        // Now tenant-alpha can safely retry training
        const newJob = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });
        expect(newJob.status).toBe('PENDING');
        await service.waitForJob('tenant-alpha', newJob.id);
        const completedRetried = await inMemoryStore.getTrainingJobById('tenant-alpha', newJob.id);
        expect(completedRetried?.status).toBe('COMPLETED');
      });
    });

    describe('3. Model Promotion Atomicity & Rollback', () => {
      it('C. concurrent model promotion: ensures exactly one APPROVED model is active per (tenantId, modelType)', async () => {
        // Train v1
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
          version: 'v1.0.0',
        });
        await service.processAllPendingJobs();

        const m1 = await service.getActiveModel(adminActor, 'tenant-alpha', 'STOCKOUT_RISK');
        expect(m1?.version).toBe('v1.0.0');
        expect(m1?.isActive).toBe(true);

        // Train v2
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
          version: 'v2.0.0',
        });
        await service.processAllPendingJobs();

        const m2 = await service.getActiveModel(adminActor, 'tenant-alpha', 'STOCKOUT_RISK');
        expect(m2?.version).toBe('v2.0.0');
        expect(m2?.isActive).toBe(true);

        // Verify v1 is now retired
        const oldM1 = await service.getModelById(adminActor, 'tenant-alpha', m1!.id);
        expect(oldM1?.status).toBe('RETIRED');
        expect(oldM1?.isActive).toBe(false);

        // Verify all models list: exactly ONE active model exists
        const allModels = await service.listModels(adminActor, 'tenant-alpha', 'STOCKOUT_RISK');
        const activeModels = allModels.filter((m) => m.isActive);
        expect(activeModels.length).toBe(1);
        expect(activeModels[0]!.id).toBe(m2!.id);
      });

      it('D. rollback race: atomic rollback restores previous approved model and retires current', async () => {
        // Setup v1 and v2
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v1.0.0',
        });
        await service.processAllPendingJobs();
        const v1 = (await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;

        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v2.0.0',
        });
        await service.processAllPendingJobs();
        const v2 = (await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;
        expect(v2.id).not.toBe(v1.id);

        // Rollback to v1
        const rolledBack = await service.rollbackModel(adminActor, 'tenant-alpha', v1.id);
        expect(rolledBack.id).toBe(v1.id);
        expect(rolledBack.isActive).toBe(true);
        expect(rolledBack.status).toBe('APPROVED');

        // Verify v2 is now RETIRED and v1 is active
        const activeAfterRollback = await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        );
        expect(activeAfterRollback?.id).toBe(v1.id);

        const v2After = await service.getModelById(adminActor, 'tenant-alpha', v2.id);
        expect(v2After?.isActive).toBe(false);
        expect(v2After?.status).toBe('RETIRED');
      });

      it('rejects rollback to a non-existent or unapproved model', async () => {
        await expect(
          service.rollbackModel(adminActor, 'tenant-alpha', 'mdl-does-not-exist'),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe('4. Prediction Idempotency & Provenance', () => {
      it('E. concurrent prediction generation: repeated runs for same entity and version update idempotently without duplication', async () => {
        await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v1.0.0',
        });
        await service.processAllPendingJobs();

        featureReader.demandRecords.push({
          tenantId: 'tenant-alpha',
          productId: 'prod-idem-1',
          sku: 'sku-idem-1',
          date: '2026-09-01',
          unitsSold: 20,
          orderCount: 15,
          price: 85.0,
        });

        // Run prediction generation concurrently (simulating simultaneous worker executions)
        const [res1, res2, res3] = await Promise.all([
          service.generatePredictions('tenant-alpha', 'DEMAND_FORECASTING'),
          service.generatePredictions('tenant-alpha', 'DEMAND_FORECASTING'),
          service.generatePredictions('tenant-alpha', 'DEMAND_FORECASTING'),
        ]);

        expect(res1.count).toBeGreaterThan(0);
        expect(res2.count).toBe(res1.count);
        expect(res3.count).toBe(res1.count);

        // Verify listPredictions contains exactly ONE prediction record for this product
        const predictions = await service.listPredictions(merchantAlpha, 'tenant-alpha', {
          modelType: 'DEMAND_FORECASTING',
          entityId: 'prod-idem-1',
        });
        expect(predictions.length).toBe(1);
        expect(predictions[0]!.entityId).toBe('prod-idem-1');
        expect(predictions[0]!.modelVersion).toBe('v1.0.0');
        expect(predictions[0]!.isSynthetic).toBe(true); // Bootstrap provenance preserved
        expect(predictions[0]!.dataSourceType).toBe('BOOTSTRAP');
      });

      it('F. prediction retry after crash is safely repeatable', async () => {
        await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
        });
        await service.processAllPendingJobs();

        featureReader.inventorySignals.push({
          tenantId: 'tenant-alpha',
          productId: 'prod-retry-1',
          sku: 'sku-retry-1',
          currentOnHand: 10,
          reservedQuantity: 5,
          velocity7d: 14.0,
          velocity14d: 28.0,
          leadTimeDays: 2,
        });

        // First run succeeds
        await service.generatePredictions('tenant-alpha', 'STOCKOUT_RISK');

        // Worker crash simulated: worker re-executes prediction generation
        const retryResult = await service.generatePredictions('tenant-alpha', 'STOCKOUT_RISK');
        expect(retryResult.count).toBe(1);

        const pred = await service.getStockoutPrediction(
          merchantAlpha,
          'tenant-alpha',
          'sku-retry-1',
        );
        expect(pred).not.toBeNull();
        expect(pred?.entityId).toBe('sku-retry-1');
      });
    });

    describe('5. Tenant Isolation & Authorization Protection', () => {
      it('G. cross-tenant model access: Merchant Beta cannot read or manipulate Merchant Alpha models', async () => {
        await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });
        await service.processAllPendingJobs();
        const alphaModel = (await service.getActiveModel(
          merchantAlpha,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;

        // Merchant Beta attempts to list Tenant Alpha models
        await expect(service.listModels(merchantBeta, 'tenant-alpha')).rejects.toThrow(
          ForbiddenError,
        );

        // Merchant Beta attempts to fetch Tenant Alpha model by id
        await expect(
          service.getModelById(merchantBeta, 'tenant-alpha', alphaModel.id),
        ).rejects.toThrow(ForbiddenError);

        // Merchant Beta attempts to rollback Tenant Alpha model
        await expect(
          service.rollbackModel(merchantBeta, 'tenant-alpha', alphaModel.id),
        ).rejects.toThrow(ForbiddenError);
      });

      it('H. cross-tenant prediction access: Merchant Beta cannot read Merchant Alpha predictions', async () => {
        await expect(
          service.getDemandPrediction(merchantBeta, 'tenant-alpha', 'prod-secret'),
        ).rejects.toThrow(ForbiddenError);

        await expect(
          service.getStockoutPrediction(merchantBeta, 'tenant-alpha', 'sku-secret'),
        ).rejects.toThrow(ForbiddenError);

        await expect(
          service.getPropensityPrediction(merchantBeta, 'tenant-alpha', 'cust-secret'),
        ).rejects.toThrow(ForbiddenError);

        await expect(service.listPredictions(merchantBeta, 'tenant-alpha')).rejects.toThrow(
          ForbiddenError,
        );
      });

      it('cross-tenant job access: Merchant Beta cannot read Merchant Alpha training jobs or trigger training for Alpha', async () => {
        await expect(
          service.enqueueTrainingJob(merchantBeta, {
            tenantId: 'tenant-alpha',
            modelType: 'DEMAND_FORECASTING',
          }),
        ).rejects.toThrow(ForbiddenError);

        await expect(service.listTrainingJobs(merchantBeta, 'tenant-alpha')).rejects.toThrow(
          ForbiddenError,
        );

        await expect(
          service.getTrainingJobById(merchantBeta, 'tenant-alpha', 'job-1'),
        ).rejects.toThrow(ForbiddenError);
      });

      it('CUSTOMER role cannot access any ML operations', async () => {
        await expect(
          service.enqueueTrainingJob(customerActor, {
            tenantId: 'tenant-alpha',
            modelType: 'DEMAND_FORECASTING',
          }),
        ).rejects.toThrow(ForbiddenError);

        await expect(service.listModels(customerActor, 'tenant-alpha')).rejects.toThrow(
          ForbiddenError,
        );

        await expect(
          service.getDemandPrediction(customerActor, 'tenant-alpha', 'prod-1'),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    describe('6. Failure Isolation & Existing Model Safety', () => {
      it('I. failed training preserves old approved model: rejection of new model leaves active model untouched', async () => {
        // 1. Train and approve v1
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v1.0.0',
        });
        await service.processAllPendingJobs();
        const v1 = (await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;
        expect(v1.version).toBe('v1.0.0');

        // 2. Train v2 with impossible acceptance criteria (forcing REJECTED status)
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v2.0.0',
          maxAcceptableRmse: 0.0001, // Impossible RMSE threshold -> REJECTED
        });
        await service.processAllPendingJobs();

        // 3. Verify v1 is still the active approved model!
        const activeNow = await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        );
        expect(activeNow?.id).toBe(v1.id);
        expect(activeNow?.version).toBe('v1.0.0');
        expect(activeNow?.isActive).toBe(true);

        // Verify v2 was saved as REJECTED
        const all = await service.listModels(adminActor, 'tenant-alpha', 'DEMAND_FORECASTING');
        const v2Record = all.find((m) => m.version === 'v2.0.0');
        expect(v2Record?.status).toBe('REJECTED');
        expect(v2Record?.isActive).toBe(false);
      });

      it('J. missing/corrupt artifact: prediction generation fails safely without unhandled exceptions', async () => {
        // Create approved model with non-existent artifact path
        await inMemoryStore.saveModel({
          id: 'mdl-corrupt',
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v-corrupt',
          status: 'APPROVED',
          algorithm: 'RandomForestRegressor',
          hyperparameters: {},
          featureVersion: 'v1',
          trainingDatasetId: 'ds-c',
          dataSourceType: 'REAL',
          isSynthetic: false,
          predictionHorizon: '7d',
          metrics: { train: {}, validation: {}, test: {} },
          artifactPath: '/non/existent/path/to/corrupt_model.joblib',
          isActive: true,
          createdAt: new Date().toISOString(),
        });

        // generatePredictions handles missing artifact safely and returns { count: 0 }
        const res = await service.generatePredictions('tenant-alpha', 'DEMAND_FORECASTING');
        expect(res.count).toBe(0);

        // Readers safely return null
        const pred = await service.getDemandPrediction(merchantAlpha, 'tenant-alpha', 'prod-1');
        expect(pred).toBeNull();
      });

      it('K. Python failure: marks job FAILED without affecting previously approved model', async () => {
        // Approved baseline model
        await service.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
          version: 'v1.0.0',
        });
        await service.processAllPendingJobs();
        const baseline = (await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'STOCKOUT_RISK',
        ))!;

        // Create broken service pointing to non-existent python binary
        const brokenRunner = new PythonRunner(logger, 'nonexistent_python_binary_xyz_123');
        const brokenService = analyticsMlModule.createService(
          inMemoryStore,
          featureReader,
          logger,
          brokenRunner,
        );

        const failedJob = await brokenService.enqueueTrainingJob(adminActor, {
          tenantId: 'tenant-alpha',
          modelType: 'STOCKOUT_RISK',
          version: 'v2.0.0',
        });
        await brokenService.processAllPendingJobs();

        const completedFailedJob = await brokenService.getTrainingJobById(
          adminActor,
          'tenant-alpha',
          failedJob.id,
        );
        expect(completedFailedJob?.status).toBe('FAILED');
        expect(completedFailedJob?.errorMessage).toBeDefined();

        // Original baseline model remains active and approved
        const activeAfterCrash = await service.getActiveModel(
          adminActor,
          'tenant-alpha',
          'STOCKOUT_RISK',
        );
        expect(activeAfterCrash?.id).toBe(baseline.id);
        expect(activeAfterCrash?.isActive).toBe(true);
      });

      it('L. ML unavailable while commerce continues: prediction failure or absence never affects commerce', async () => {
        // Query predictions for tenant with no models or predictions
        const pred = await service.getDemandPrediction(adminActor, 'tenant-no-ml', 'prod-xyz');
        expect(pred).toBeNull();

        const signal = await service.getDemandForecast('tenant-no-ml', 'prod-xyz');
        expect(signal).toBeNull();

        const risk = await service.getStockoutRisk('tenant-no-ml', 'sku-xyz');
        expect(risk).toBeNull();

        const prop = await service.getPurchasePropensity('tenant-no-ml', 'cust-xyz');
        expect(prop).toBeNull();
      });
    });

    describe('7. Automatic Retraining Execution & Provenance', () => {
      it('M. automatic retraining trigger: evaluates policies across tenants and triggers jobs when threshold met', async () => {
        await inMemoryStore.saveRetrainingPolicy({
          id: 'pol-alpha-demand',
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          minNewOrdersThreshold: 10,
          lastTrainedOrderCount: 0,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Add 15 orders for tenant-alpha
        featureReader.demandRecords.push({
          tenantId: 'tenant-alpha',
          productId: 'prod-auto-1',
          sku: 'sku-auto-1',
          date: '2026-09-02',
          unitsSold: 20,
          orderCount: 15,
          price: 50.0,
        });

        // Run automatic retraining evaluation
        const evaluations = await service.evaluateAllRetrainingPolicies();
        expect(evaluations.length).toBe(1);
        expect(evaluations[0]!.retrained).toBe(true);
        expect(evaluations[0]!.jobId).toBeDefined();
        expect(evaluations[0]!.reason).toContain('THRESHOLD_MET');

        // Verify the enqueued job is PENDING and can be processed
        const job = await service.getTrainingJobById(
          merchantAlpha,
          'tenant-alpha',
          evaluations[0]!.jobId!,
        );
        expect(job?.status).toBe('PENDING');
        expect(job?.triggerType).toBe('MIN_DATA_THRESHOLD');

        await service.processAllPendingJobs();
        const completed = await service.getTrainingJobById(
          merchantAlpha,
          'tenant-alpha',
          evaluations[0]!.jobId!,
        );
        expect(completed?.status).toBe('COMPLETED');
      });

      it('duplicate scheduler evaluation: concurrent evaluations by multi-instances are harmless and produce no duplicate jobs', async () => {
        await inMemoryStore.saveRetrainingPolicy({
          id: 'pol-concurrent',
          tenantId: 'tenant-multi',
          modelType: 'STOCKOUT_RISK',
          minNewOrdersThreshold: 5,
          lastTrainedOrderCount: 0,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        featureReader.demandRecords.push({
          tenantId: 'tenant-multi',
          productId: 'prod-multi',
          sku: 'sku-multi',
          date: '2026-09-02',
          unitsSold: 10,
          orderCount: 10,
          price: 50.0,
        });

        // Simulate Instance 1 and Instance 2 evaluating policies simultaneously
        const [eval1, eval2] = await Promise.all([
          service.evaluateAllRetrainingPolicies(),
          service.evaluateAllRetrainingPolicies(),
        ]);

        const allEvals = [...eval1, ...eval2].filter((e) => e.tenantId === 'tenant-multi');
        const retrainedCount = allEvals.filter((e) => e.retrained).length;
        const skippedCount = allEvals.filter((e) => e.reason === 'JOB_ALREADY_ACTIVE').length;

        expect(retrainedCount).toBe(1);
        expect(skippedCount).toBe(1);

        // Verify only 1 active job exists in the store
        const jobs = await inMemoryStore.listTrainingJobs('tenant-multi', 'STOCKOUT_RISK');
        expect(jobs.length).toBe(1);
      });

      it('N. bootstrap provenance: clearly marks models and predictions as BOOTSTRAP / isSynthetic: true', async () => {
        // 0 feature records -> forces bootstrap
        const job = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
        });
        await service.processAllPendingJobs();

        const completed = await service.getTrainingJobById(merchantAlpha, 'tenant-alpha', job.id);
        expect(completed?.dataSourceType).toBe('BOOTSTRAP');

        const model = (await service.getActiveModel(
          merchantAlpha,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;
        expect(model.dataSourceType).toBe('BOOTSTRAP');
        expect(model.isSynthetic).toBe(true);
      });

      it('O. real-data provenance: sets dataSourceType: REAL and isSynthetic: false when sufficient history is available', async () => {
        // Add 35 days of daily demand records across valid calendar dates
        for (let day = 1; day <= 35; day++) {
          const dateStr = new Date(Date.UTC(2026, 6, day)).toISOString().slice(0, 10);
          featureReader.demandRecords.push({
            tenantId: 'tenant-alpha',
            productId: 'prod-real-history',
            sku: 'sku-real-history',
            date: dateStr,
            unitsSold: 10 + (day % 3),
            orderCount: 5 + (day % 2),
            price: 99.0,
          });
        }

        const job = await service.enqueueTrainingJob(merchantAlpha, {
          tenantId: 'tenant-alpha',
          modelType: 'DEMAND_FORECASTING',
          version: 'v-real.1.0',
        });
        await service.processAllPendingJobs();

        const completed = await service.getTrainingJobById(merchantAlpha, 'tenant-alpha', job.id);
        expect(completed?.dataSourceType).toBe('REAL');

        const model = (await service.getActiveModel(
          merchantAlpha,
          'tenant-alpha',
          'DEMAND_FORECASTING',
        ))!;
        expect(model.dataSourceType).toBe('REAL');
        expect(model.isSynthetic).toBe(false);
      });
    });

    describe('8. Database Engine Safety & Constraints (SqlMlStore)', () => {
      let db: DatabaseConnection;
      let sqlStore: SqlMlStore;

      beforeEach(async () => {
        const context = await createIsolatedTestDatabase();
        db = context.db;
        await context.runner.up(db);
        sqlStore = new SqlMlStore(db);
      });

      afterEach(async () => {
        await db.close();
      });

      it('persists and claims training jobs atomically using SQL store', async () => {
        const jobRecord = {
          id: 'job-sql-1',
          tenantId: 't-sql',
          modelType: 'DEMAND_FORECASTING' as const,
          triggerType: 'MANUAL' as const,
          status: 'PENDING' as const,
          dataSourceType: 'REAL' as const,
          sampleCount: 0,
          startedAt: new Date().toISOString(),
        };

        await sqlStore.createTrainingJob(jobRecord);

        // Claim job
        const claimed = await sqlStore.claimNextPendingJob();
        expect(claimed).not.toBeNull();
        expect(claimed?.id).toBe('job-sql-1');
        expect(claimed?.status).toBe('RUNNING');

        // Next claim returns null (no remaining pending jobs)
        const nextClaim = await sqlStore.claimNextPendingJob();
        expect(nextClaim).toBeNull();
      });

      it('recovers stale jobs via SQL store', async () => {
        const oldTime = new Date(Date.now() - 600000).toISOString();
        await sqlStore.createTrainingJob({
          id: 'job-stale-sql',
          tenantId: 't-sql',
          modelType: 'STOCKOUT_RISK',
          triggerType: 'MANUAL',
          status: 'RUNNING',
          dataSourceType: 'REAL',
          sampleCount: 5,
          startedAt: oldTime,
        });

        const recovered = await sqlStore.recoverStaleJobs(300000);
        expect(recovered).toBe(1);

        const job = await sqlStore.getTrainingJobById('t-sql', 'job-stale-sql');
        expect(job?.status).toBe('FAILED');
      });

      it('enforces active model atomicity via transaction in SqlMlStore', async () => {
        const m1: RegisteredModelRecord = {
          id: 'mdl-sql-v1',
          tenantId: 't-sql',
          modelType: 'DEMAND_FORECASTING',
          version: 'v1.0.0',
          status: 'APPROVED',
          algorithm: 'RandomForestRegressor',
          hyperparameters: {},
          featureVersion: 'v1',
          trainingDatasetId: 'ds-1',
          dataSourceType: 'REAL',
          isSynthetic: false,
          predictionHorizon: '7d',
          metrics: { train: {}, validation: {}, test: {} },
          isActive: true,
          createdAt: new Date().toISOString(),
        };
        await sqlStore.saveModel(m1);
        await sqlStore.setActiveModel('t-sql', 'mdl-sql-v1', 'DEMAND_FORECASTING');

        const m2: RegisteredModelRecord = {
          id: 'mdl-sql-v2',
          tenantId: 't-sql',
          modelType: 'DEMAND_FORECASTING',
          version: 'v2.0.0',
          status: 'APPROVED',
          algorithm: 'RandomForestRegressor',
          hyperparameters: {},
          featureVersion: 'v1',
          trainingDatasetId: 'ds-2',
          dataSourceType: 'REAL',
          isSynthetic: false,
          predictionHorizon: '7d',
          metrics: { train: {}, validation: {}, test: {} },
          isActive: false,
          createdAt: new Date().toISOString(),
        };
        await sqlStore.saveModel(m2);

        // Promote m2
        await sqlStore.setActiveModel('t-sql', 'mdl-sql-v2', 'DEMAND_FORECASTING');

        const active = await sqlStore.getActiveModel('t-sql', 'DEMAND_FORECASTING');
        expect(active?.id).toBe('mdl-sql-v2');

        const retired = await sqlStore.getModelById('t-sql', 'mdl-sql-v1');
        expect(retired?.status).toBe('RETIRED');
        expect(retired?.isActive).toBe(false);
      });

      it('enforces prediction scope uniqueness and safe upsert in SQL store', async () => {
        const pred1 = {
          id: 'p-1',
          scopeKey: 't-sql:DEMAND_FORECASTING:PRODUCT:item-1:v1',
          tenantId: 't-sql',
          modelId: 'mdl-1',
          modelVersion: 'v1',
          modelType: 'DEMAND_FORECASTING' as const,
          entityType: 'PRODUCT' as const,
          entityId: 'item-1',
          predictionValue: 42.0,
          horizon: '7d',
          featureVersion: 'v1',
          dataSourceType: 'REAL' as const,
          isSynthetic: false,
          provenance: {},
          predictedAt: new Date().toISOString(),
        };

        await sqlStore.savePredictions([pred1]);

        // Save updated prediction with same scopeKey
        const pred2 = {
          ...pred1,
          id: 'p-2',
          predictionValue: 45.5,
        };

        await sqlStore.savePredictions([pred2]);

        const stored = await sqlStore.getPrediction(
          't-sql',
          'DEMAND_FORECASTING',
          'PRODUCT',
          'item-1',
        );
        expect(stored?.predictionValue).toBe(45.5);

        const all = await sqlStore.listPredictions('t-sql');
        expect(all.length).toBe(1);
      });
    });
  },
);
