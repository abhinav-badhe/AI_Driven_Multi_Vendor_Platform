/**
 * BOUNDED CONTEXT: Analytics & ML
 * Ownership: Predictive ML training pipelines, model registry, versioned predictions,
 * and automated retraining policies.
 *
 * Architecture Invariant:
 * - ML is a derived, optional intelligence layer.
 * - ML code MUST NOT query transactional tables directly.
 * - ML code MUST NOT directly write or mutate transactional business truth.
 * - ML consumes feature signals exclusively through authorized, typed, tenant-aware Analytics read interfaces.
 */

import type { Logger } from '../../observability/logger.js';
import type { IAnalyticsMlFeatureReader } from '../analytics/index.js';
import { InMemoryMlStore } from './internal/in-memory-ml-store.js';
import type {
  DataSourceType,
  DerivedPredictionRecord,
  EntityType,
  IMlSignalReader,
  IMlStore,
  ModelMetrics,
  ModelStatus,
  ModelType,
  PredictionResultDto,
  RegisteredModelRecord,
  RetrainingPolicyRecord,
  TrainingJobRecord,
  TrainModelInputDto,
  TriggerType,
} from './internal/ml-models.js';
import { MlService } from './internal/ml-service.js';
import { PythonRunner } from './internal/python-runner.js';

export type {
  ModelType,
  ModelStatus,
  DataSourceType,
  TriggerType,
  EntityType,
  ModelMetrics,
  RegisteredModelRecord,
  TrainingJobRecord,
  DerivedPredictionRecord,
  RetrainingPolicyRecord,
  TrainModelInputDto,
  PredictionResultDto,
  IMlStore,
  IMlSignalReader,
};

export { InMemoryMlStore, MlService, PythonRunner };

export interface AnalyticsMlModule {
  readonly contextName: 'analytics-ml';
  createService(
    store: IMlStore,
    featureReader: IAnalyticsMlFeatureReader,
    logger: Logger,
    pythonRunner?: PythonRunner,
  ): MlService;
  createDefaultStore(): IMlStore;
  createPythonRunner(logger: Logger, pythonBin?: string, projectRoot?: string): PythonRunner;
}

export const analyticsMlModule: AnalyticsMlModule = {
  contextName: 'analytics-ml',
  createService(
    store: IMlStore,
    featureReader: IAnalyticsMlFeatureReader,
    logger: Logger,
    pythonRunner?: PythonRunner,
  ): MlService {
    const runner = pythonRunner ?? new PythonRunner(logger);
    return new MlService(store, featureReader, logger, runner);
  },
  createDefaultStore(): IMlStore {
    return new InMemoryMlStore();
  },
  createPythonRunner(logger: Logger, pythonBin?: string, projectRoot?: string): PythonRunner {
    return new PythonRunner(logger, pythonBin, projectRoot);
  },
};
