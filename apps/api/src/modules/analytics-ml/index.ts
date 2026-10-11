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
import { PythonRunner, type PythonTrainResult, type PythonPredictResult } from './internal/python-runner.js';
import type {
  IMlExecutionProvider,
  IMlInferenceProvider,
  IMlTrainingProvider,
  MlPredictResult,
  MlTrainResult,
} from './internal/ml-execution-provider.js';
import { LocalPythonMlExecutionProvider, CompositeMlExecutionProvider } from './internal/ml-execution-provider.js';
import {
  HttpMlExecutionProvider,
  HttpMlProviderError,
  type HttpMlExecutionProviderConfig,
  type HttpMlExecutionProviderOptions,
} from './internal/http-ml-execution-provider.js';

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
  IMlInferenceProvider,
  IMlTrainingProvider,
  IMlExecutionProvider,
  MlTrainResult,
  MlPredictResult,
  PythonTrainResult,
  PythonPredictResult,
  HttpMlExecutionProviderConfig,
  HttpMlExecutionProviderOptions,
};

export {
  InMemoryMlStore,
  MlService,
  PythonRunner,
  LocalPythonMlExecutionProvider,
  CompositeMlExecutionProvider,
  HttpMlExecutionProvider,
  HttpMlProviderError,
};

export interface AnalyticsMlModule {
  readonly contextName: 'analytics-ml';
  createService(
    store: IMlStore,
    featureReader: IAnalyticsMlFeatureReader,
    logger: Logger,
    executionProvider?: IMlExecutionProvider | PythonRunner,
  ): MlService;
  createDefaultStore(): IMlStore;
  createPythonRunner(logger: Logger, pythonBin?: string, projectRoot?: string): PythonRunner;
  createLocalExecutionProvider(runnerOrLogger: PythonRunner | Logger): LocalPythonMlExecutionProvider;
  createCompositeExecutionProvider(
    inferenceProvider: IMlInferenceProvider,
    trainingProvider: IMlTrainingProvider,
  ): CompositeMlExecutionProvider;
  createHttpExecutionProvider(
    configOrBaseUrl: string | HttpMlExecutionProviderConfig,
    options?: HttpMlExecutionProviderOptions,
  ): HttpMlExecutionProvider;
}

export const analyticsMlModule: AnalyticsMlModule = {
  contextName: 'analytics-ml',
  createService(
    store: IMlStore,
    featureReader: IAnalyticsMlFeatureReader,
    logger: Logger,
    executionProvider?: IMlExecutionProvider | PythonRunner,
  ): MlService {
    const provider = executionProvider
      ? executionProvider instanceof PythonRunner
        ? new LocalPythonMlExecutionProvider(executionProvider)
        : executionProvider
      : new LocalPythonMlExecutionProvider(new PythonRunner(logger));
    return new MlService(store, featureReader, logger, provider);
  },
  createDefaultStore(): IMlStore {
    return new InMemoryMlStore();
  },
  createPythonRunner(logger: Logger, pythonBin?: string, projectRoot?: string): PythonRunner {
    return new PythonRunner(logger, pythonBin, projectRoot);
  },
  createLocalExecutionProvider(runnerOrLogger: PythonRunner | Logger): LocalPythonMlExecutionProvider {
    return new LocalPythonMlExecutionProvider(runnerOrLogger);
  },
  createCompositeExecutionProvider(
    inferenceProvider: IMlInferenceProvider,
    trainingProvider: IMlTrainingProvider,
  ): CompositeMlExecutionProvider {
    return new CompositeMlExecutionProvider(inferenceProvider, trainingProvider);
  },
  createHttpExecutionProvider(
    configOrBaseUrl: string | HttpMlExecutionProviderConfig,
    options?: HttpMlExecutionProviderOptions,
  ): HttpMlExecutionProvider {
    return new HttpMlExecutionProvider(configOrBaseUrl, options);
  },
};
