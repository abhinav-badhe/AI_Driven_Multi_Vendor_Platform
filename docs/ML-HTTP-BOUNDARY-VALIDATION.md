# Integration Boundary Validation: Node.js API ML Layer ↔ Standalone ML Service

## 1. Scope

This document provides a **read-only, source-code-verified integration boundary audit** between the Node.js API analytics/ML domain (`apps/api`) and the standalone Python ML inference microservice (`apps/ml-service`).

The objective is to establish with mathematical and architectural certainty whether the HTTP inference seam introduced via `HttpMlExecutionProvider` can replace `LocalPythonMlExecutionProvider` in a future migration step without:

1. Changing prediction semantics or numerical outputs.
2. Breaking batching, entity mapping, or idempotency keys.
3. Violating input schema constraints on either side of the transport boundary.
4. Causing unhandled failures or breaking transactional business operations.

---

## 2. Node-Side Request Contract

### 2.1 Caller Source: `MlService.generatePredictions`

- **Location**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (lines 508–602)
- **Invocation**: `await this.executionProvider.runPrediction(payload)`
- **Payload Construction**:
  ```typescript
  {
    modelType: ModelType,       // 'DEMAND_FORECASTING' | 'STOCKOUT_RISK' | 'PURCHASE_PROPENSITY' | 'ANOMALY_DETECTION'
    artifactPath: string,          // activeModel.artifactPath from RegisteredModelRecord
    features: Array<{             // Generated from Analytics feature readers
      entityId: string,
      featureVector: number[]
    }>
  }
  ```

### 2.2 Client Transport: `HttpMlExecutionProvider.runPrediction`

- **Location**: `apps/api/src/modules/analytics-ml/internal/http-ml-execution-provider.ts` (lines 66–96)
- **HTTP Method**: `POST`
- **Endpoint**: `${this.baseUrl}/v1/predict`
- **Headers**:
  - `Content-Type`: `application/json`
  - `Accept`: `application/json`
- **Serialization**: `JSON.stringify(payload)`
- **Status**: `[VERIFIED]` The exact JSON object constructed by `MlService` is transmitted without modification, property pruning, or renaming.

---

## 3. ML-Service Request Contract

### 3.1 Receiver Schema: `apps/ml-service/app/api/routes.py`

- **Location**: `apps/ml-service/app/api/routes.py` (lines 24–33, 92–104)
- **Pydantic Models**:
  ```python
  class FeatureItem(BaseModel):
      entityId: str = Field(..., min_length=1, description="Entity identifier (product, SKU, customer, or order)")
      featureVector: List[float] = Field(..., description="Dense numerical feature vector")

  class PredictRequest(BaseModel):
      modelType: str = Field(..., min_length=1, description="Model type selector")
      artifactPath: str = Field(..., min_length=1, description="Path or relative name of model artifact")
      features: List[FeatureItem] = Field(default_factory=list, description="List of entity feature vectors to score")
  ```

### 3.2 Property-by-Property Schema Alignment

| Field                       | Node Type (`apps/api`)       | Python Schema (`apps/ml-service`) | Status       | Notes                                                 |
| :-------------------------- | :--------------------------- | :-------------------------------- | :----------- | :---------------------------------------------------- |
| `modelType`                 | `string` (`ModelType` union) | `str` (validated against set)     | `[VERIFIED]` | Identical keys and value enums across both codebases. |
| `artifactPath`              | `string`                     | `str`                             | `[VERIFIED]` | String passed directly to path resolver.              |
| `features`                  | `Array<FeatureItem>`         | `List[FeatureItem]`               | `[VERIFIED]` | Exact array of objects.                               |
| `features[i].entityId`      | `string`                     | `str` (`min_length=1`)            | `[VERIFIED]` | Non-empty string preserved.                           |
| `features[i].featureVector` | `number[]`                   | `List[float]`                     | `[VERIFIED]` | Dense array of 64-bit IEEE floats.                    |

---

## 4. Response Contract Comparison

### 4.1 ML-Service Response Schema: `/v1/predict`

- **Location**: `apps/ml-service/app/api/routes.py` (lines 35–45)
  ```python
  class PredictionItem(BaseModel):
      entityId: str
      predictionValue: float
      probability: Optional[float] = None
      confidence: Optional[float] = None

  class PredictResponse(BaseModel):
      success: bool = True
      predictions: List[PredictionItem] = Field(default_factory=list)
  ```

### 4.2 Client Deserialization: `HttpMlExecutionProvider.runPrediction`

- **Location**: `apps/api/src/modules/analytics-ml/internal/http-ml-execution-provider.ts` (lines 161–174)
  ```typescript
  const predictions = (resObj.predictions as Array<Record<string, unknown>>).map((item) => ({
    entityId: String(item.entityId ?? ''),
    predictionValue: Number(item.predictionValue ?? 0),
    probability: item.probability != null ? Number(item.probability) : null,
    confidence: item.confidence != null ? Number(item.confidence) : null,
  }));
  return { success: true, predictions };
  ```

### 4.3 Node `MlService` Consumption

- **Location**: `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (lines 620–647)
  ```typescript
  for (const pred of predResult.predictions) {
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
      // ...
    });
  }
  ```

### 4.4 Field Compatibility Assessment

| Response Field    | ML Service Emitted Type | Provider Mapped Type    | MlService Consumed Field               | Status       |
| :---------------- | :---------------------- | :---------------------- | :------------------------------------- | :----------- |
| `success`         | `bool` (`True`)         | `boolean` (`true`)      | Checked via `!predResult.success`      | `[VERIFIED]` |
| `predictions`     | `List[PredictionItem]`  | `Array<PredictionItem>` | Iterated via `for (const pred of ...)` | `[VERIFIED]` |
| `entityId`        | `str`                   | `string`                | Used in `scopeKey` and `entityId`      | `[VERIFIED]` |
| `predictionValue` | `float`                 | `number`                | Persisted as `predictionValue`         | `[VERIFIED]` |
| `probability`     | `float \| None`         | `number \| null`        | Persisted as `probability`             | `[VERIFIED]` |
| `confidence`      | `float \| None`         | `number \| null`        | Persisted as `confidence`              | `[VERIFIED]` |

---

## 5. Four-Model Compatibility Matrix

Both the Node feature extraction pipeline (`apps/api/src/modules/analytics-ml/internal/ml-service.ts`) and the shared inference engine (`ml/inference/engine.py`) were inspected across all four models:

| Model Type                | Node Feature Vector Extracted (Length)                                                   | Python Training Feature Names (`ml/data/features.py`)                                                                      | Python Scoring Method (`InferenceEngine`)    | Output Semantics                                                                                         | Status       |
| :------------------------ | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- | :------------------------------------------------------------------------------------------------------- | :----------- |
| **`DEMAND_FORECASTING`**  | 8 features: `[lag1, lag7, mean7, mean14, 1.5, price, dow, isWeekend]`                    | 8 features: `[lag_1, lag_7, rolling_mean_7, rolling_mean_14, promo_multiplier, base_price, day_of_week, is_weekend]`       | `model.predict(X)` (Regressor)               | `predictionValue: round(val, 2)`<br>`probability: null`<br>`confidence: 0.85`                            | `[VERIFIED]` |
| **`STOCKOUT_RISK`**       | 7 features: `[onHand, reserved, v7, v14, daysOfSupply, runoutRate, leadTimeDays]`        | 7 features: `[current_on_hand, reserved_quantity, velocity_7d, velocity_14d, days_of_supply, runout_rate, lead_time_days]` | `model.predict_proba(X)` (Binary Classifier) | `predictionValue: round(p, 4)`<br>`probability: round(p, 4)`<br>`confidence: round(abs(p - 0.5) * 2, 4)` | `[VERIFIED]` |
| **`PURCHASE_PROPENSITY`** | 6 features: `[recencyDays, frequency30d, frequency90d, totalOrders, monetaryTotal, aov]` | 6 features: `[recency_days, frequency_30d, frequency_90d, total_orders, monetary_total, aov]`                              | `model.predict_proba(X)` (Binary Classifier) | `predictionValue: round(p, 4)`<br>`probability: round(p, 4)`<br>`confidence: round(abs(p - 0.5) * 2, 4)` | `[VERIFIED]` |
| **`ANOMALY_DETECTION`**   | 6 features: `[logTotal, lineCount, qty, avgItemPrice, hourOfDay, isNightOrder]`          | 6 features: `[log_total_amount, line_count, total_quantity, avg_item_price, hour_of_day, is_night_order]`                  | `model.predict_proba(X)` (Binary Classifier) | `predictionValue: round(p, 4)`<br>`probability: round(p, 4)`<br>`confidence: round(abs(p - 0.5) * 2, 4)` | `[VERIFIED]` |

---

## 6. Error Compatibility Matrix

Comparison of error propagation between `LocalPythonMlExecutionProvider` and `HttpMlExecutionProvider`:

| Failure Scenario                         | Standalone Service Emitted Response                                                 | `HttpMlExecutionProvider` Client Behavior                                | `LocalPythonMlExecutionProvider` Baseline Behavior    | `MlService.generatePredictions` Final Outcome               | Status       |
| :--------------------------------------- | :---------------------------------------------------------------------------------- | :----------------------------------------------------------------------- | :---------------------------------------------------- | :---------------------------------------------------------- | :----------- |
| **Invalid Model Type**                   | HTTP 400 Bad Request `{"success": false, "error": "Unknown model type: ..."}`       | Throws `HttpMlProviderError` (400, `ML_SERVICE_HTTP_ERROR`)              | Returns `{ success: false, error: "..." }`            | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **Missing Model Artifact**               | HTTP 404 Not Found `{"success": false, "error": "Artifact not found: ..."}`         | Throws `HttpMlProviderError` (404, `ML_SERVICE_HTTP_ERROR`)              | Returns `{ success: false, error: "..." }`            | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **Invalid Feature Vector Dimension**     | HTTP 500 Internal Error `{"success": false, "error": "X has N features, but..."}`   | Throws `HttpMlProviderError` (500, `ML_SERVICE_HTTP_ERROR`)              | Returns `{ success: false, error: "..." }`            | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **Invalid Feature Data Type**            | HTTP 422 Unprocessable Entity `{"success": false, "error": "Validation failed..."}` | Throws `HttpMlProviderError` (422, `ML_SERVICE_HTTP_ERROR`)              | Fails in Python parsing, returns `{ success: false }` | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **ML Service Down / Connection Refused** | Network Connection Refused (`ECONNREFUSED`)                                         | Throws `HttpMlProviderError` (502, `ML_SERVICE_NETWORK_ERROR`)           | N/A (runs in-process child process)                   | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **Request Timeout**                      | Server processing exceeds configured `timeoutMs`                                    | Aborts request, throws `HttpMlProviderError` (504, `ML_SERVICE_TIMEOUT`) | Child process killed after 30s timeout                | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |
| **Malformed / Truncated JSON Response**  | HTTP 200 with invalid JSON body                                                     | Throws `HttpMlProviderError` (502, `ML_SERVICE_MALFORMED_RESPONSE`)      | JSON.parse fails, returns `{ success: false }`        | Catches error, logs warning, returns `{ count: 0 }` safely. | `[VERIFIED]` |

### Invariant Verification: Monolith Resilience

In all failure cases, `MlService.generatePredictions` wraps provider execution in a top-level `try/catch` block (lines 509, 651–655):

```typescript
try {
  // ... runPrediction ...
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  this.logger.warn('Safe prediction generation caught error and returned empty count', {
    error: msg,
  });
  return { count: 0 };
}
```

**Conclusion**: `[VERIFIED]` Switching from local return-based error objects to HTTP exceptions does **not** crash callers, abort database transactions, or expose internal ML errors to frontend users.

---

## 7. Batching Validation

Batching guarantees were inspected across the pipeline:

1. **Input Array Order**:
   - `MlService` populates `featureVectors` sequentially.
   - `HttpMlExecutionProvider` transmits `features` as a JSON array preserving index ordering.
2. **Scoring Engine Vectorization**:
   - In `InferenceEngine.score_vectors` (`ml/inference/engine.py` lines 55–57):
     ```python
     vectors = [item["featureVector"] for item in features_input]
     X = np.array(vectors)
     ```
   - Scikit-learn estimators (`predict` / `predict_proba`) return an array of shape `(N,)` or `(N, K)` where row index $i$ corresponds directly to `features_input[i]`.
   - Results loop constructs:
     ```python
     for i, item in enumerate(features_input):
         results.append({
             "entityId": item["entityId"],
             ...
         })
     ```
3. **Output Cardinality**:
   - For an input of $N$ items, the engine produces exactly $N$ predictions.
   - For $N = 0$, both sides immediately return `{ count: 0 }` without executing scoring.
4. **Idempotency Scope Keys**:
   - `MlService` constructs `scopeKey = `${tenantId}:${modelType}:${entityType}:${pred.entityId}:${activeModel.version}``.
   - Because `entityId` matches 1-to-1 with input feature vectors, repeated batch execution safely upserts into the store without duplication.
5. **Status**: `[VERIFIED]` Batching cardinality, indexing, and entity identity are strictly preserved.

---

## 8. Artifact-Path and Security Compatibility

### 8.1 Security Validation in `apps/ml-service`

`apps/ml-service/app/config.py` enforces path traversal protection via `resolve_safe_artifact_path`:

```python
def resolve_safe_artifact_path(artifact_path: str, artifact_root: str = None) -> str:
    root = os.path.realpath(os.path.abspath(artifact_root or settings.artifact_root))
    cleaned = artifact_path.strip()
    if os.path.isabs(cleaned):
        candidate = os.path.realpath(os.path.abspath(cleaned))
    else:
        norm = os.path.normpath(cleaned)
        parts = norm.split(os.sep)
        if parts and parts[0] == ".ml_artifacts":
            norm = os.sep.join(parts[1:])
        candidate = os.path.realpath(os.path.abspath(os.path.join(root, norm)))

    common = os.path.commonpath([root, candidate])
    if common != root or candidate == root:
        raise ValueError("Path traversal detected...")
    return candidate
```

### 8.2 Path Compatibility Analysis

1. **Bare Filename**:
   - Input: `tenant-1_DEMAND_FORECASTING_v1.joblib`
   - Resolution: `${artifact_root}/tenant-1_DEMAND_FORECASTING_v1.joblib`
   - Status: `[VERIFIED]` Resolves safely inside root.
2. **Relative Path with `.ml_artifacts`**:
   - Input: `.ml_artifacts/tenant-1_DEMAND_FORECASTING_v1.joblib`
   - Resolution: Strips `.ml_artifacts` prefix and joins with `artifact_root`.
   - Status: `[VERIFIED]` Prevents double-nesting.
3. **Absolute Path on Same Host (Current Monolith / Local Dev)**:
   - Input: `C:/.../ai-driven-multi-vendor-predictive-ecom-platform/.ml_artifacts/model.joblib`
   - Resolution: Since `REPO_ROOT` resolves to the shared repository root on the same host, `commonpath([root, candidate]) == root`.
   - Status: `[VERIFIED]` Works cleanly in local development.

---

## 9. Identified Mismatches and Risks

### 9.1 `[RISK]` Absolute Path Portability in Disaggregated Deployments

- **Current Behavior**: `ml/train.py` outputs `artifact_path = os.path.join(artifact_dir, artifact_filename)`. When run by `PythonRunner`, this writes an **absolute filesystem path** to the database (e.g. `C:\Users\...\.ml_artifacts\model.joblib` on Windows or `/home/user/.../.ml_artifacts/model.joblib` on Linux).
- **Risk in Distributed Architecture**: If `apps/api` runs in Container A (e.g. `/workspace/api`) and `apps/ml-service` runs in Container B (e.g. `/app/ml-service` with a shared volume mounted at `/var/ml_artifacts`), `candidate` will be an absolute path from Container A that does **not** reside within Container B's `artifact_root`.
- **Mitigation Requirement Before Production Cutover**:
  Model training metadata should store relative artifact paths or bare filenames (e.g. `tenant-1_DEMAND_FORECASTING_v1.joblib`), OR an artifact key/URI abstraction (e.g., `s3://...` or `relative:.ml_artifacts/...`) should be introduced when persistent shared storage is provisioned.

### 9.2 `[MISMATCH]` Training Is Unsupported by the HTTP Inference Provider

- **Current Behavior**:
  - `LocalPythonMlExecutionProvider.runTraining(...)` executes training pipelines via `PythonRunner`.
  - `HttpMlExecutionProvider.runTraining(...)` explicitly rejects training with `HttpMlProviderError` (HTTP 501, `ML_TRAINING_NOT_SUPPORTED`).
- **Impact**: The monolith cannot simply swap `executionProvider` globally in `apps/api/src/app.ts` if training jobs are triggered on the same provider instance.
- **Mitigation Requirement Before Cutover**:
  Either:
  1. Decouple `IMlExecutionProvider` into `IMlInferenceProvider` and `IMlTrainingProvider`.
  2. Or maintain `LocalPythonMlExecutionProvider` for asynchronous training jobs while routing `runPrediction` calls to `HttpMlExecutionProvider`.

### 9.3 `[NOT VERIFIED]` End-to-End Live HTTP Socket Latency Under High Load

- **Status**: `[NOT VERIFIED]`
- **Detail**: Unit tests verified the mock fetch boundary, and Python unit tests verified FastAPI route handlers. However, live network latency, serialization overhead for large batch vectors (e.g. 5,000 entities), and connection pooling under sustained concurrent HTTP traffic have not yet been load-tested against a live running server (strictly deferred per read-only safety rules).

---

## 10. Cutover Readiness Assessment

### 10.1 Readiness Checklist

- [x] **Schema Equivalence**: Exact parity on input payloads and output predictions `[VERIFIED]`.
- [x] **Algorithm Fidelity**: Identical scoring math and Scikit-learn models across all 4 model types `[VERIFIED]`.
- [x] **Batch Cardinality**: Strict 1-to-1 preserving entityId and index order `[VERIFIED]`.
- [x] **Failure Resilience**: Monolith safely traps and isolates all HTTP errors `[VERIFIED]`.
- [ ] **Artifact Path Decoupling**: Absolute host paths must be normalized to relative paths for cross-container sharing `[RISK]`.
- [ ] **Training vs Inference Separation**: Monolith must retain local training capability while delegating inference `[MISMATCH]`.

### 10.2 Final Verdict: **CONDITIONALLY READY FOR SHADOW / DUAL-RUN**

The prediction boundary is **100% contract-compatible**. The monolith can safely utilize `HttpMlExecutionProvider` for prediction scoring as soon as:

1. Training execution remains separated on the local runner.
2. The ML service base URL is provided via environment configuration.
3. Artifact paths are ensured to be relative or shared across environments.

---

## 11. Exact Files Inspected

1. **Monolith ML Execution Boundary**:
   - `apps/api/src/modules/analytics-ml/internal/ml-service.ts`
   - `apps/api/src/modules/analytics-ml/internal/ml-execution-provider.ts`
   - `apps/api/src/modules/analytics-ml/internal/http-ml-execution-provider.ts`
   - `apps/api/src/modules/analytics-ml/internal/python-runner.ts`
   - `apps/api/src/modules/analytics-ml/index.ts`
2. **Standalone ML Service**:
   - `apps/ml-service/app/main.py`
   - `apps/ml-service/app/config.py`
   - `apps/ml-service/app/api/routes.py`
3. **Reusable Inference Engine & Training Pipelines**:
   - `ml/inference/engine.py`
   - `ml/train.py`
   - `ml/predict.py`
   - `ml/data/features.py`
4. **Test Verification Boundaries**:
   - `apps/api/test/http-ml-execution-provider.test.ts`
   - `apps/api/test/ml-execution-provider.test.ts`
   - `apps/ml-service/tests/test_api.py`
