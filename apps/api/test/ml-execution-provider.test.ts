import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonLogger } from '../src/observability/logger.js';
import {
  analyticsMlModule,
  InMemoryMlStore,
  LocalPythonMlExecutionProvider,
  MlService,
  PythonRunner,
  type IMlExecutionProvider,
  type IMlInferenceProvider,
  type IMlTrainingProvider,
  type PythonPredictResult,
  type PythonTrainResult,
} from '../src/modules/analytics-ml/index.js';
import type {
  CustomerActivitySignal,
  IAnalyticsMlFeatureReader,
  InventoryVelocitySignal,
  OrderAnomalySignal,
  ProductDailyDemandRecord,
} from '../src/modules/analytics/index.js';
import type { AuthorizedActor } from '../src/modules/identity/index.js';

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

class FakeMlExecutionProvider implements IMlExecutionProvider {
  public lastTrainingConfig: Record<string, unknown> | null = null;
  public lastPredictionPayload: Record<string, unknown> | null = null;

  public trainResultToReturn: PythonTrainResult = {
    success: true,
    modelId: 'mdl-mock-1',
    status: 'APPROVED',
    algorithm: 'MockAlgorithm',
    metrics: { train: { rmse: 1.0 }, validation: { rmse: 1.2 }, test: { rmse: 1.5 } },
    sampleCount: 50,
    artifactPath: '/mock/path/model.joblib',
  };

  public predictResultToReturn: PythonPredictResult = {
    success: true,
    predictions: [
      { entityId: 'prod-1', predictionValue: 42.0, probability: null, confidence: 0.9 },
    ],
  };

  async runTraining(config: Record<string, unknown>): Promise<PythonTrainResult> {
    this.lastTrainingConfig = config;
    return this.trainResultToReturn;
  }

  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    this.lastPredictionPayload = payload;
    return this.predictResultToReturn;
  }
}

describe('ML Execution Provider Boundary', () => {
  const logger = new JsonLogger({ serviceName: 'ml-provider-test', level: 'error' });
  const actor: AuthorizedActor = { userId: 'u-1', tenantId: 'tenant-test', role: 'MERCHANT' };

  describe('1. LocalPythonMlExecutionProvider Delegation', () => {
    it('delegates runTraining to underlying PythonRunner with exact config', async () => {
      const runner = new PythonRunner(logger);
      const expectedResult: PythonTrainResult = {
        success: true,
        modelId: 'mdl-123',
        status: 'APPROVED',
        algorithm: 'RandomForestRegressor',
      };
      const runTrainingSpy = vi.spyOn(runner, 'runTraining').mockResolvedValueOnce(expectedResult);

      const provider = new LocalPythonMlExecutionProvider(runner);
      const config = { tenantId: 'tenant-test', modelType: 'DEMAND_FORECASTING', seed: 42 };

      const result = await provider.runTraining(config);

      expect(runTrainingSpy).toHaveBeenCalledTimes(1);
      expect(runTrainingSpy).toHaveBeenCalledWith(config);
      expect(result).toBe(expectedResult);
    });

    it('delegates runPrediction to underlying PythonRunner with exact payload', async () => {
      const runner = new PythonRunner(logger);
      const expectedResult: PythonPredictResult = {
        success: true,
        predictions: [{ entityId: 'e-1', predictionValue: 99.5 }],
      };
      const runPredictionSpy = vi
        .spyOn(runner, 'runPrediction')
        .mockResolvedValueOnce(expectedResult);

      const provider = new LocalPythonMlExecutionProvider(runner);
      const payload = {
        modelType: 'DEMAND_FORECASTING',
        features: [{ entityId: 'e-1', featureVector: [1, 2, 3] }],
      };

      const result = await provider.runPrediction(payload);

      expect(runPredictionSpy).toHaveBeenCalledTimes(1);
      expect(runPredictionSpy).toHaveBeenCalledWith(payload);
      expect(result).toBe(expectedResult);
    });

    it('implements separated IMlTrainingProvider and IMlInferenceProvider interfaces', () => {
      const runner = new PythonRunner(logger);
      const provider = new LocalPythonMlExecutionProvider(runner);

      const trainingProvider: IMlTrainingProvider = provider;
      const inferenceProvider: IMlInferenceProvider = provider;
      const executionProvider: IMlExecutionProvider = provider;

      expect(typeof trainingProvider.runTraining).toBe('function');
      expect(typeof inferenceProvider.runPrediction).toBe('function');
      expect(typeof executionProvider.runTraining).toBe('function');
      expect(typeof executionProvider.runPrediction).toBe('function');
    });

    it('faithfully propagates training error status from PythonRunner', async () => {
      const runner = new PythonRunner(logger);
      const errorResult: PythonTrainResult = {
        success: false,
        status: 'FAILED',
        error: 'Process timeout exceeded',
      };
      vi.spyOn(runner, 'runTraining').mockResolvedValueOnce(errorResult);

      const provider = new LocalPythonMlExecutionProvider(runner);
      const result = await provider.runTraining({
        tenantId: 'tenant-test',
        modelType: 'DEMAND_FORECASTING',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.error).toBe('Process timeout exceeded');
    });

    it('faithfully propagates prediction error status from PythonRunner', async () => {
      const runner = new PythonRunner(logger);
      const errorResult: PythonPredictResult = {
        success: false,
        error: 'Artifact file not found',
      };
      vi.spyOn(runner, 'runPrediction').mockResolvedValueOnce(errorResult);

      const provider = new LocalPythonMlExecutionProvider(runner);
      const result = await provider.runPrediction({ modelType: 'DEMAND_FORECASTING' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Artifact file not found');
    });

    it('propagates thrown exceptions from PythonRunner without suppression', async () => {
      const runner = new PythonRunner(logger);
      vi.spyOn(runner, 'runTraining').mockRejectedValueOnce(new Error('Fatal OS process failure'));

      const provider = new LocalPythonMlExecutionProvider(runner);
      await expect(provider.runTraining({})).rejects.toThrow('Fatal OS process failure');
    });
  });

  describe('2. MlService Dependency on IMlExecutionProvider', () => {
    let store: InMemoryMlStore;
    let featureReader: MockFeatureReader;
    let fakeProvider: FakeMlExecutionProvider;
    let service: MlService;

    beforeEach(() => {
      store = new InMemoryMlStore();
      featureReader = new MockFeatureReader();
      fakeProvider = new FakeMlExecutionProvider();
      service = new MlService(store, featureReader, logger, fakeProvider);
    });

    it('executes training job through injected provider and stores approved model', async () => {
      const job = await service.enqueueTrainingJob(actor, {
        tenantId: 'tenant-test',
        modelType: 'DEMAND_FORECASTING',
        version: 'v1.0.0',
      });

      expect(job.status).toBe('PENDING');

      const completed = await service.processNextPendingJob();

      expect(completed).not.toBeNull();
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.modelId).toBe('mdl-mock-1');

      // Verify provider was invoked with extracted features and parameters
      expect(fakeProvider.lastTrainingConfig).not.toBeNull();
      expect(fakeProvider.lastTrainingConfig?.tenantId).toBe('tenant-test');
      expect(fakeProvider.lastTrainingConfig?.modelType).toBe('DEMAND_FORECASTING');

      // Verify active model was registered in store
      const activeModel = await service.getActiveModel(actor, 'tenant-test', 'DEMAND_FORECASTING');
      expect(activeModel).not.toBeNull();
      expect(activeModel?.id).toBe('mdl-mock-1');
      expect(activeModel?.status).toBe('APPROVED');
      expect(activeModel?.isActive).toBe(true);
    });

    it('handles rejected model decision when provider evaluates below threshold', async () => {
      fakeProvider.trainResultToReturn = {
        success: true,
        modelId: 'mdl-mock-rejected',
        status: 'REJECTED',
        rejectionReason: 'Test RMSE 150.00 exceeded threshold 100.00',
        algorithm: 'RandomForestRegressor',
        metrics: { train: {}, validation: {}, test: { rmse: 150.0 } },
      };

      await service.enqueueTrainingJob(actor, {
        tenantId: 'tenant-test',
        modelType: 'DEMAND_FORECASTING',
      });

      const completed = await service.processNextPendingJob();

      expect(completed?.status).toBe('FAILED');
      expect(completed?.errorMessage).toBe('Test RMSE 150.00 exceeded threshold 100.00');

      // Model saved as REJECTED, not active
      const model = await service.getModelById(actor, 'tenant-test', 'mdl-mock-rejected');
      expect(model?.status).toBe('REJECTED');
      expect(model?.isActive).toBe(false);

      const active = await service.getActiveModel(actor, 'tenant-test', 'DEMAND_FORECASTING');
      expect(active).toBeNull();
    });

    it('handles provider execution failure gracefully without crashing', async () => {
      fakeProvider.trainResultToReturn = {
        success: false,
        status: 'FAILED',
        error: 'Execution failed in container',
      };

      await service.enqueueTrainingJob(actor, {
        tenantId: 'tenant-test',
        modelType: 'DEMAND_FORECASTING',
      });

      const completed = await service.processNextPendingJob();

      expect(completed?.status).toBe('FAILED');
      expect(completed?.errorMessage).toBe('Execution failed in container');
    });

    it('invokes prediction scoring through injected provider and persists records', async () => {
      // First register an active approved model in the store
      await store.saveModel({
        id: 'mdl-mock-1',
        tenantId: 'tenant-test',
        modelType: 'DEMAND_FORECASTING',
        version: 'v1.0.0',
        status: 'APPROVED',
        algorithm: 'MockAlgorithm',
        hyperparameters: {},
        featureVersion: 'v1',
        trainingDatasetId: 'ds-1',
        dataSourceType: 'BOOTSTRAP',
        isSynthetic: true,
        predictionHorizon: '7d',
        metrics: { train: {}, validation: {}, test: {} },
        artifactPath: '/mock/path/model.joblib',
        isActive: true,
        createdAt: new Date().toISOString(),
      });

      // Add demand history so features are extracted
      featureReader.demandRecords.push({
        tenantId: 'tenant-test',
        productId: 'prod-1',
        sku: 'sku-1',
        date: '2026-10-01',
        unitsSold: 10,
        orderCount: 5,
        price: 99.0,
      });

      fakeProvider.predictResultToReturn = {
        success: true,
        predictions: [
          { entityId: 'prod-1', predictionValue: 55.0, probability: null, confidence: 0.88 },
        ],
      };

      const res = await service.generatePredictions('tenant-test', 'DEMAND_FORECASTING');

      expect(res.count).toBe(1);
      expect(fakeProvider.lastPredictionPayload).not.toBeNull();
      expect(fakeProvider.lastPredictionPayload?.modelType).toBe('DEMAND_FORECASTING');
      expect(fakeProvider.lastPredictionPayload?.artifactPath).toBe('/mock/path/model.joblib');

      const savedPred = await service.getDemandPrediction(actor, 'tenant-test', 'prod-1');
      expect(savedPred).not.toBeNull();
      expect(savedPred?.predictionValue).toBe(55.0);
    });
  });

  describe('3. Module Construction and Factory Wiring', () => {
    it('analyticsMlModule.createService wraps PythonRunner in LocalPythonMlExecutionProvider', () => {
      const store = new InMemoryMlStore();
      const reader = new MockFeatureReader();
      const runner = new PythonRunner(logger);

      const service = analyticsMlModule.createService(store, reader, logger, runner);
      expect(service).toBeInstanceOf(MlService);
    });

    it('analyticsMlModule.createService accepts custom IMlExecutionProvider directly', () => {
      const store = new InMemoryMlStore();
      const reader = new MockFeatureReader();
      const fake = new FakeMlExecutionProvider();

      const service = analyticsMlModule.createService(store, reader, logger, fake);
      expect(service).toBeInstanceOf(MlService);
    });

    it('analyticsMlModule.createService creates default LocalPythonMlExecutionProvider when omitted', () => {
      const store = new InMemoryMlStore();
      const reader = new MockFeatureReader();

      const service = analyticsMlModule.createService(store, reader, logger);
      expect(service).toBeInstanceOf(MlService);
    });

    it('analyticsMlModule.createLocalExecutionProvider returns LocalPythonMlExecutionProvider instance', () => {
      const runner = new PythonRunner(logger);
      const provider = analyticsMlModule.createLocalExecutionProvider(runner);
      expect(provider).toBeInstanceOf(LocalPythonMlExecutionProvider);
    });
  });
});
