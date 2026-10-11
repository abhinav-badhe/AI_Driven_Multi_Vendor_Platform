import type { Logger } from '../../../observability/logger.js';
import type { PythonPredictResult, PythonTrainResult } from './python-runner.js';
import { PythonRunner } from './python-runner.js';

/**
 * Execution result shapes for ML operations.
 * Re-uses exact existing Python runner contracts to preserve runtime compatibility.
 */
export type MlTrainResult = PythonTrainResult;
export type MlPredictResult = PythonPredictResult;

/**
 * BOUNDARY: Machine Learning Inference Provider
 *
 * Encapsulates model scoring / inference execution.
 * Pure execution abstraction: dispatches entity feature vectors to the scoring runtime.
 */
export interface IMlInferenceProvider {
  /**
   * Dispatches entity feature vectors to the ML execution runtime for model scoring.
   */
  runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult>;
}

/**
 * BOUNDARY: Machine Learning Training Provider
 *
 * Encapsulates model training pipeline execution.
 * Pure execution abstraction: dispatches training configurations to the training runtime.
 */
export interface IMlTrainingProvider {
  /**
   * Dispatches a model training configuration to the ML execution runtime.
   */
  runTraining(config: Record<string, unknown>): Promise<PythonTrainResult>;
}

/**
 * BOUNDARY: Machine Learning Execution Provider (Composite Compatibility Interface)
 *
 * Unifies training and inference contracts for backward compatibility during migration.
 * Encapsulates the execution boundary away from MlService business logic.
 *
 * Invariants:
 * - Pure execution abstraction: owns zero database access, model registry, or feature query logic.
 * - Stateless with respect to caller business transactions.
 */
export interface IMlExecutionProvider extends IMlTrainingProvider, IMlInferenceProvider {}

/**
 * Local Python Implementation of IMlExecutionProvider.
 *
 * Adapts the existing PythonRunner (node:child_process + temporary JSON files)
 * to the IMlExecutionProvider interface without altering command-line flags,
 * timeouts, path resolutions, or file cleanup behavior.
 */
export class LocalPythonMlExecutionProvider implements IMlExecutionProvider {
  private readonly runner: PythonRunner;

  constructor(runnerOrLogger: PythonRunner | Logger) {
    if (runnerOrLogger instanceof PythonRunner) {
      this.runner = runnerOrLogger;
    } else {
      this.runner = new PythonRunner(runnerOrLogger);
    }
  }

  async runTraining(config: Record<string, unknown>): Promise<PythonTrainResult> {
    return this.runner.runTraining(config);
  }

  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    return this.runner.runPrediction(payload);
  }
}

/**
 * Composite ML Execution Provider.
 * Decouples inference and training: delegates model scoring / predictions to an
 * independent IMlInferenceProvider (such as HttpMlExecutionProvider targeting the
 * standalone microservice) while delegating training to an IMlTrainingProvider.
 */
export class CompositeMlExecutionProvider implements IMlExecutionProvider {
  constructor(
    private readonly inferenceProvider: IMlInferenceProvider,
    private readonly trainingProvider: IMlTrainingProvider,
  ) {}

  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    return this.inferenceProvider.runPrediction(payload);
  }

  async runTraining(config: Record<string, unknown>): Promise<PythonTrainResult> {
    return this.trainingProvider.runTraining(config);
  }
}
