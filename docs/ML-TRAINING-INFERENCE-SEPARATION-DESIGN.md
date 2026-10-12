# Architectural Seam Design: ML Training vs ML Inference Separation

## 1. Executive Summary & Purpose

This document provides a **read-only architectural design** for decoupling Machine Learning **Training** from Machine Learning **Inference** in the predictive e-commerce platform.

In previous phases, we introduced `IMlExecutionProvider` and implemented both:

1. `LocalPythonMlExecutionProvider` (executes both training and inference via local Python child processes).
2. `HttpMlExecutionProvider` (dispatches inference over HTTP to `apps/ml-service`, but explicitly rejects training).

The boundary audit (`docs/ML-HTTP-BOUNDARY-VALIDATION.md`) confirmed that while inference scoring is 100% contract-compatible, `IMlExecutionProvider` currently couples two fundamentally different workloads:

- **Inference**: Latency-critical, high-throughput, stateless, read-heavy scoring.
- **Training**: Long-running, resource-intensive, stateful, batch data engineering and model fitting.

This design defines the precise architectural seam needed to separate training and inference without modifying application behavior, database schemas, or existing production wiring.

---

## 2. Current State Inspection

### 2.1 Current Provider Abstraction

- **File**: `apps/api/src/modules/analytics-ml/internal/ml-execution-provider.ts`
- **Definition**:
  ```typescript
  export interface IMlExecutionProvider {
    runTraining(config: Record<string, unknown>): Promise<PythonTrainResult>;
    runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult>;
  }
  ```
- **Finding `[VERIFIED]`**: Both training and inference operations are currently declared on a single interface.

### 2.2 Current Training Invocation

- **File**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (lines 170–201)
- **Call Site**: Inside the private method `executeJob(job: TrainingJobRecord)`:
  ```typescript
  const trainResult = await this.executionProvider.runTraining(trainConfig);
  ```
- **Trigger Paths**:
  1. **Manual Training Request**: HTTP `POST /ml/train` → `mlRoutes` → `MlService.trainModel` → `enqueueTrainingJob` (`PENDING`) → `triggerBackgroundWorker` → `processNextPendingJob` → `executeJob`.
  2. **Automated Retraining**: `MlService.evaluateAllRetrainingPolicies` or `retrainIfEligible` → `enqueueTrainingJob` (`PENDING`) → background worker → `executeJob`.
  3. **Synchronous Waiter**: `MlService.waitForJob(tenantId, jobId)` → drains pending jobs via `executeJob`.
- **Finding `[VERIFIED]`**: `runTraining` is invoked from exactly **one** private execution method (`executeJob`) inside `MlService`. Callers never invoke `runTraining` directly; they always enqueue durable jobs in the database (`ml_training_jobs`).

### 2.3 Current Inference Invocation

- **File**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (lines 508–602)
- **Call Site**: Inside the public method `generatePredictions(tenantId: string, modelType: ModelType)`:
  ```typescript
  const predResult = await this.executionProvider.runPrediction({
    modelType,
    artifactPath: activeModel.artifactPath,
    features: featureVectors,
  });
  ```
- **Trigger Paths**:
  1. **Post-Promotion Baseline Generation**: When a candidate model is trained and approved (`isApproved = true`), `executeJob` promotes the model via `store.setActiveModel` and immediately calls `this.generatePredictions(tenantId, modelType)` (line 252).
  2. **Scheduled / Manual Prediction Sweeps**: Invoked during periodic background sweeps or in integration tests.
- **Finding `[VERIFIED]`**: `runPrediction` is invoked from exactly **one** method (`generatePredictions`) inside `MlService`.
- **Finding `[VERIFIED]`**: External consumers (such as the AI Agent / RAG via `IMlSignalReader` or merchant REST queries via `GET /ml/predictions/*`) **do not call inference directly**. Instead, they read pre-generated derived prediction records persisted in `ml_predictions` from `IMlStore`.

### 2.4 Current Production Provider Wiring

- **File**: `apps/api/src/app.ts` (line 364)
  ```typescript
  const mlService = analyticsService
    ? analyticsMlModule.createService(mlStore, analyticsService, rootLogger)
    : null;
  ```
- **File**: `apps/api/src/modules/analytics-ml/index.ts` (lines 90–95)
  ```typescript
  createService(...) {
    const provider = executionProvider
      ? executionProvider instanceof PythonRunner
        ? new LocalPythonMlExecutionProvider(executionProvider)
        : executionProvider
      : new LocalPythonMlExecutionProvider(new PythonRunner(logger));
    return new MlService(store, featureReader, logger, provider);
  }
  ```
- **Finding `[VERIFIED]`**: The monolith defaults exclusively to `LocalPythonMlExecutionProvider(new PythonRunner(logger))`. `HttpMlExecutionProvider` is not wired into the application runtime.

---

## 3. Dependency Map

### 3.1 Current End-to-End Call Flow

```
[TRAINING FLOW]
HTTP POST /ml/train  ──► mlRoutes.ts
                              │
                              ▼
                      MlService.trainModel
                              │
                              ▼
                      enqueueTrainingJob (status: PENDING in ml_training_jobs)
                              │
                              ▼
                      processNextPendingJob / executeJob
                              │
                              ▼
                      IMlExecutionProvider.runTraining(config)
                              │
                              ▼
                      LocalPythonMlExecutionProvider
                              │
                              ▼
                      PythonRunner.runTraining
                              │
                              ▼
                      execFile('python ml/train.py --input ... --output ...')
                              │
                              ▼
                      Serialized Artifact (.joblib in .ml_artifacts)
                              │
                              ▼
                      MlService.saveModel & setActiveModel (ml_models)
                              │
                              ▼ (if APPROVED)
                      MlService.generatePredictions
                              │
                              ▼
[INFERENCE FLOW]      IMlExecutionProvider.runPrediction(payload)
                              │
                              ▼
                      LocalPythonMlExecutionProvider
                              │
                              ▼
                      PythonRunner.runPrediction
                              │
                              ▼
                      execFile('python ml/predict.py --input ... --output ...')
                              │
                              ▼
                      ml.inference.engine.generate_predictions
                              │
                              ▼
                      DerivedPredictionRecords saved in ml_predictions
```

### 3.2 Target Separated Call Flow

```
[TRAINING EXECUTION]                                  [INFERENCE EXECUTION]
MlService (or Training Worker)                        MlService.generatePredictions
          │                                                         │
          ▼                                                         ▼
IMlTrainingProvider.runTraining                       IMlInferenceProvider.runPrediction
          │                                                         │
          ▼                                                         ▼
LocalPythonMlTrainingProvider                         HttpMlInferenceProvider
(or Celery / Temporal / K8s Job)                                    │
          │                                                         ▼
          ▼                                                 POST /v1/predict
python ml/train.py                                                  │
          │                                                         ▼
          ▼                                                 apps/ml-service
Shared Artifact Storage                                     (FastAPI microservice)
(Relative Key / Shared Storage) ─────────────────────────►          │
          │                                                         ▼
          ▼                                                 ml.inference.engine
Model Registered in DB (ml_models)                                  │
                                                                    ▼
                                                            Persisted in ml_predictions
```

---

## 4. Separation Options Evaluation

We evaluate the two candidate architectural approaches against the current codebase:

### Option A: Split `IMlExecutionProvider` into `IMlInferenceProvider` and `IMlTrainingProvider`

#### Proposed Interface Definitions:

```typescript
/**
 * Dedicated contract for model scoring / prediction.
 */
export interface IMlInferenceProvider {
  runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult>;
}

/**
 * Dedicated contract for model training execution.
 */
export interface IMlTrainingProvider {
  runTraining(config: Record<string, unknown>): Promise<PythonTrainResult>;
}

/**
 * Composite legacy provider maintaining 100% backward compatibility.
 */
export interface IMlExecutionProvider extends IMlInferenceProvider, IMlTrainingProvider {}
```

#### Provider Implementations:

1. `LocalPythonMlExecutionProvider`:
   - Implements `IMlExecutionProvider` (both `IMlTrainingProvider` and `IMlInferenceProvider`).
   - Retains exact existing behavior.
2. `HttpMlExecutionProvider` (or `HttpMlInferenceProvider`):
   - Implements only `IMlInferenceProvider`.
   - Does **not** declare or implement `runTraining`.
   - Eliminates the throwing 501 stub method entirely.
3. `MlService` Dependency Injection:
   ```typescript
   export interface MlServiceProviders {
     trainingProvider: IMlTrainingProvider;
     inferenceProvider: IMlInferenceProvider;
   }

   constructor(
     store: IMlStore,
     featureReader: IAnalyticsMlFeatureReader,
     logger: Logger,
     providersOrExecutionProvider: IMlExecutionProvider | MlServiceProviders,
   )
   ```

#### Evaluation:

- **Interface Segregation Principle (ISP)**: Satisfied. Clients and providers only depend on the methods they actually support.
- **Runtime Safety**: No fake stubs. An inference-only HTTP service cannot be accidentally invoked for training.
- **Backward Compatibility**: Fully preserved. Existing tests passing `IMlExecutionProvider` or `PythonRunner` continue working without modification because `IMlExecutionProvider` extends both interfaces.

---

### Option B: Keep `IMlExecutionProvider` and Compose Internally

#### Proposed Structure:

Keep `IMlExecutionProvider` unchanged. Create a composite provider:

```typescript
export class CompositeMlExecutionProvider implements IMlExecutionProvider {
  constructor(
    private readonly trainingProvider: { runTraining: ... },
    private readonly inferenceProvider: { runPrediction: ... },
  ) {}

  async runTraining(config) { return this.trainingProvider.runTraining(config); }
  async runPrediction(payload) { return this.inferenceProvider.runPrediction(payload); }
}
```

#### Evaluation:

- **Interface Segregation**: Violated. `IMlExecutionProvider` remains a "fat interface" requiring any provider implementation to handle both concerns.
- **Runtime Safety**: `HttpMlExecutionProvider` still needs to exist as an `IMlExecutionProvider`, meaning it must keep the `runTraining` stub that throws `ML_TRAINING_NOT_SUPPORTED` at runtime.
- **Code Overhead**: Adds an extra wrapper layer (`CompositeMlExecutionProvider`) without fixing the fundamental contract mismatch discovered in Prompt 8.

---

### Recommended Approach: **OPTION A** `[RECOMMENDED]`

**Rationale**:

1. **Accurate Domain Reflection**: `apps/ml-service` is explicitly an inference microservice. Forcing it to implement a training interface is an architectural code smell.
2. **Clean Separation of Asynchronous vs Synchronous Concerns**: Training is an asynchronous batch pipeline (producing job IDs, metrics, artifacts); inference is a synchronous calculation (producing predictions).
3. **Zero Breakage**: Making `IMlExecutionProvider extends IMlInferenceProvider, IMlTrainingProvider` ensures that all existing tests and monolith code remain valid with zero regressions.

---

## 5. Target Responsibility Boundaries

To maintain clean modular boundaries during migration, responsibilities are partitioned as follows:

| Component                                               | Responsibility                                                                                                                                                                                                                                                                                                  | Allowed Dependencies                                                                                                                     | Prohibited Actions                                                                                                                                         |
| :------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node Monolith (`apps/api`)**                          | • Exposes tenant REST APIs (`/ml/*`).<br>• Manages durable jobs (`ml_training_jobs`).<br>• Model registry & promotions (`ml_models`).<br>• Feature extraction via Analytics domain.<br>• Idempotent persistence of predictions (`ml_predictions`).<br>• Supplies predictions to AI Agent via `IMlSignalReader`. | • PostgreSQL (`commerce_db`).<br>• Analytics feature readers.<br>• HTTP client to `apps/ml-service`.<br>• Local Python runner (interim). | • Direct numerical model fitting.<br>• Model deserialization (.joblib parsing).<br>• Direct NumPy/Scikit-learn execution.                                  |
| **Standalone ML Inference Service (`apps/ml-service`)** | • Stateless model scoring (`POST /v1/predict`).<br>• Deserializes & caches model artifacts.<br>• Vectorized NumPy/Scikit-learn scoring.<br>• Health & readiness probes (`/health`, `/ready`).                                                                                                                   | • Shared artifact storage (read-only).<br>• Shared `ml.inference.engine`.                                                                | • **NO database connection**.<br>• **NO transactional queries**.<br>• **NO model training routines**.<br>• **NO direct feature generation from database**. |
| **ML Training Worker (Future Dedicated Component)**     | • Executes training pipeline (`ml/train.py`).<br>• Synthesizes cold-start bootstrap data.<br>• Fits Scikit-learn regressors/classifiers.<br>• Evaluates RMSE / accuracy metrics.<br>• Serializes model artifacts to shared storage.<br>• Emits training job results.                                            | • Input training dataset/records.<br>• Shared artifact storage (write-only).<br>• Local Python ML runtime.                               | • Handling live inference requests.<br>• Mutating active transactional database truth.<br>• Serving frontend API endpoints.                                |

---

## 6. Future Cutover Flow

When the application is cut over to use the separated providers:

```
                          ┌───────────────────────────────┐
                          │   Node Monolith (MlService)   │
                          └──────┬─────────────────┬──────┘
                                 │                 │
                (Training Action)│                 │(Inference Action)
                                 ▼                 ▼
             ┌─────────────────────────┐     ┌──────────────────────────┐
             │   IMlTrainingProvider   │     │   IMlInferenceProvider   │
             └───────────┬─────────────┘     └─────────────┬────────────┘
                         │                                 │
                         ▼                                 ▼
           LocalPythonMlTrainingProvider         HttpMlInferenceProvider
                         │                                 │
                         ▼                                 ▼ (HTTP POST /v1/predict)
                  ml/train.py                     apps/ml-service
                         │                                 │
                         │                                 │
                         ▼                                 ▼
                  Writes .joblib                    Reads .joblib
                         │                                 │
                         └───────────────┬─────────────────┘
                                         ▼
                             Shared Artifact Storage
                             (Identified by Key/URI)
```

1. **Training & Model Registration**:
   - Monolith receives training request and enqueues job in `ml_training_jobs`.
   - `trainingProvider.runTraining(config)` executes training.
   - Model artifact is written to shared storage under a normalized key (e.g., `tenant-1/DEMAND_FORECASTING/v1.0.0.joblib`).
   - Result metadata (metrics, sample count, status, artifact key) is returned to `MlService`.
   - `MlService` persists the model in `ml_models`. If accepted, promotes to active.
2. **Prediction Generation**:
   - `MlService.generatePredictions` queries active model metadata (`artifactKey`, `modelType`, `version`).
   - Feature reader extracts feature vectors from Analytics read interfaces.
   - `inferenceProvider.runPrediction({ modelType, artifactPath: artifactKey, features })` is called.
   - `HttpMlInferenceProvider` dispatches request to `apps/ml-service`.
   - `apps/ml-service` loads artifact from shared storage, scores vectors, and returns `{ success: true, predictions: [...] }`.
   - `MlService` stores derived records into `ml_predictions` with `scopeKey`.

---

## 7. Artifact Path Portability & Identity `[RISK]`

### 7.1 Problem Identified in Audit

Currently, `ml/train.py` returns `artifactPath` as an **absolute filesystem path**:

```python
artifact_filename = f"{safe_tenant}_{model_type}_{version}.joblib"
artifact_path = os.path.join(artifact_dir, artifact_filename)
```

On Windows, this results in:
`C:\Users\Abhinav\Documents\Project2\ai-driven-multi-vendor-predictive-ecom-platform\.ml_artifacts\tenant-1_DEMAND_FORECASTING_v1.0.0.joblib`

If `apps/api` and `apps/ml-service` run in separate Docker containers or hosts, this absolute path will **fail** path resolution in the inference service because `C:\Users\...` does not exist inside the inference container.

### 7.2 Target Conceptual Artifact Identity `[FUTURE]`

The stored `artifactPath` must conceptually represent an **environment-agnostic artifact identity**, rather than an absolute host path:

1. **Relative Artifact Key**:
   - Format: `artifacts/{tenantId}/{modelType}/{version}.joblib` or simply `{tenantId}_{modelType}_{version}.joblib`.
   - Resolution: Both the training worker and the inference service resolve this relative key against their respective `ML_ARTIFACT_ROOT` environment configuration.
2. **Abstract Storage URI**:
   - Format: `storage://artifacts/{tenantId}/{modelType}/{version}.joblib`.
   - Resolution: Resolved via a shared storage client or mounted volume without hardcoded operating system paths.

_Note: Infrastructure selection (e.g. S3 vs shared NFS volume) is deferred to deployment phases. The contract change requires only storing relative/relocatable keys._

---

## 8. Migration Safety Guarantees

The proposed separation adheres strictly to safety principles:

1. **Zero Database Mutation**:
   - Schemas (`ml_models`, `ml_training_jobs`, `ml_predictions`, `ml_retraining_policies`) remain 100% unchanged.
2. **Zero Runtime Disruption**:
   - By having `LocalPythonMlExecutionProvider` implement both `IMlTrainingProvider` and `IMlInferenceProvider`, the monolith continues running exactly as it does today.
3. **Zero API Changes**:
   - All REST routes (`/ml/train`, `/ml/models`, `/ml/predictions/*`) and internal interfaces (`IMlSignalReader`) remain completely unchanged.
4. **Isolated Failure Boundaries**:
   - As validated in Prompt 8, any HTTP inference failure (timeout, network drop, 500) is trapped by `MlService.generatePredictions` and safely returns `{ count: 0 }`, never crashing business transactions.

---

## 9. Smallest Safe Sequence of Future Cutover Steps `[FUTURE]`

```
Phase A: Split Interface Boundary (Zero Behavior Change)
  │  • Split IMlExecutionProvider into IMlTrainingProvider and IMlInferenceProvider.
  │  • LocalPythonMlExecutionProvider implements both.
  │  • HttpMlExecutionProvider implements IMlInferenceProvider.
  │  • All existing tests remain green.
  ▼
Phase B: Normalize Artifact Path Identity
  │  • Update ml/train.py to record relative artifact keys in train results.
  │  • Ensure resolve_safe_artifact_path resolves relative keys consistently.
  ▼
Phase C: Support Dual Provider Injection in MlService
  │  • Allow MlService to accept separate trainingProvider and inferenceProvider.
  │  • Keep LocalPythonMlExecutionProvider as the default for both.
  ▼
Phase D: Configurable Inference Provider Selection
  │  • If ML_INFERENCE_SERVICE_URL is configured, wire HttpMlInferenceProvider
  │    for inference while keeping LocalPythonMlTrainingProvider for training.
  ▼
Phase E: Verification & Shadow Validation
  │  • Verify dual-provider operation in automated test environment.
  │  • Validate that training succeeds locally while inference executes via HTTP.
```

---

## 10. Audit Verification & Summary

### 10.1 Exact Files Inspected

1. `apps/api/src/modules/analytics-ml/internal/ml-execution-provider.ts`
2. `apps/api/src/modules/analytics-ml/internal/http-ml-execution-provider.ts`
3. `apps/api/src/modules/analytics-ml/internal/python-runner.ts`
4. `apps/api/src/modules/analytics-ml/internal/ml-service.ts`
5. `apps/api/src/modules/analytics-ml/internal/ml-models.ts`
6. `apps/api/src/modules/analytics-ml/index.ts`
7. `apps/api/src/http/ml-routes.ts`
8. `apps/api/src/app.ts`
9. `ml/train.py`
10. `ml/inference/engine.py`
11. `apps/ml-service/app/api/routes.py`
12. `apps/ml-service/app/config.py`

### 10.2 Exact Current Training Call Sites

- **Production Invocation**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (line 200, inside `executeJob`).
- **HTTP Entry Point**: `apps/api/src/http/ml-routes.ts` (line 34, inside `POST /ml/train`).
- **Policy Automation**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (lines 352, 408, inside `evaluateAllRetrainingPolicies` and `retrainIfEligible`).

### 10.3 Exact Current Inference Call Sites

- **Production Invocation**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (line 597, inside `generatePredictions`).
- **Post-Promotion Invocation**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (line 252, inside `executeJob` upon model approval).

### 10.4 Recommended Separation Approach

- **Approach A**: Split `IMlExecutionProvider` into `IMlInferenceProvider` and `IMlTrainingProvider`, with `IMlExecutionProvider` extending both for complete backward compatibility.

### 10.5 Runtime Confirmation

- **EXPLICIT CONFIRMATION**: This task was strictly read-only analysis and architectural design. **No source code was modified, no database schemas or data were changed, no models were trained, no servers were started, and NO runtime behavior was altered.**
