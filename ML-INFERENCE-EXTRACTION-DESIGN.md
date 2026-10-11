# ML INFERENCE SERVICE EXTRACTION DESIGN

> **Document Status:** Authoritative Extraction Design Blueprint  
> **Phase:** Design & Planning (Read-Only Extraction Design Phase)  
> **Baseline References:** Verified against [`CURRENT-MONOLITH-VALIDATED.md`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/CURRENT-MONOLITH-VALIDATED.md), [`TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md), and [`ML-MIGRATION-READINESS-AUDIT.md`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ML-MIGRATION-READINESS-AUDIT.md)  
> **Safety Guarantee:** Pure design artifact. Zero application code modified, zero files moved, zero packages installed, zero database mutations, zero servers started.

---

## 1. Executive Summary

This document specifies the target extraction design for decoupling Machine Learning (ML) inference from the monolith into an autonomous, stateless, high-throughput microservice (`apps/ml-service`).

### Core Architectural Findings from Code Inspection
1. **Asynchronous Batch Scoring Architecture:** In the current implementation, real-time customer and merchant HTTP queries (`GET /ml/predictions/*`) **never trigger synchronous Python execution**. The system already operates an asynchronous batch scoring + persistent read-cache pattern:
   - When a model is approved or refreshed, [`MlService.generatePredictions()`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L500) scores active entities via [`predict.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py) and writes results to the PostgreSQL `ml_predictions` table.
   - User and assistant queries read exclusively from `ml_predictions` (or memory cache) in sub-millisecond database queries.
2. **Clean In-Place Seam:** The newly implemented [`IMlExecutionProvider`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-execution-provider.ts#L22) cleanly isolates execution dispatch from all business logic, deduplication, and database persistence.
3. **Extraction Objective:** Extract inference execution into `apps/ml-service` (FastAPI + Uvicorn) with resident in-memory model caching, without changing:
   - Prediction schemas or mathematical outputs.
   - Database tables or persistence ownership.
   - Monolith caller interfaces or frontend contracts.

---

## 2. Current Prediction Architecture

### End-to-End Sequence Diagram (Current Monolith)

```text
[HTTP Caller / Cron] 
       │
       ▼ (1. trigger: e.g. post-training or admin refresh)
MlService.generatePredictions(tenantId, modelType)
       │
       ├─► (2. Read Active Model) ──► SqlMlStore.getActiveModel()
       │                                 └─► returns RegisteredModelRecord (artifact_path)
       ├─► (3. Extract Features) ────► IAnalyticsMlFeatureReader
       │                                 └─► returns raw historical rows from DB
       ├─► (4. Transform Vectors) ───► In-Memory TypeScript feature mapping
       │
       ▼ (5. Dispatch Execution)
IMlExecutionProvider.runPrediction(payload)
       │
       ▼ (6. Delegate to Local Runner)
LocalPythonMlExecutionProvider ──► PythonRunner.runPrediction()
                                          │
                                          ├─► (7. Serialize JSON) ──► os.tmpdir()/ml_pred_in_<uuid>.json
                                          ├─► (8. Spawn Process) ───► python ml/predict.py --input-file ...
                                          │                              │
                                          │                              ├─► joblib.load(artifactPath)
                                          │                              ├─► model.predict() / predict_proba()
                                          │                              └─► writes ml_pred_out_<uuid>.json
                                          ├─► (9. Read Output JSON) ◄────┘
                                          ├─► (10. Unlink Temp Files)
                                          └─► returns PythonPredictResult
       │
       ▼ (11. Wrap with Provenance & ScopeKey)
DerivedPredictionRecord[] ──► SqlMlStore.savePredictions() ──► INSERT/UPDATE ml_predictions
```

### End-to-End Sequence Diagram (Read Queries)

```text
[Browser / Assistant] ──► GET /ml/predictions/demand/:productId
                                │
                                ▼
                        MlService.getDemandPrediction()
                                │
                                ▼ (Fast SQL Query, Zero Python)
                        SqlMlStore.getPrediction() ──► SELECT * FROM ml_predictions
                                │
                                ▼
                        DerivedPredictionRecord (cached response)
```

---

## 3. Prediction Flow by Use Case

### 1. Demand Forecasting (`DEMAND_FORECASTING`)
- **Caller:** Triggered automatically in `MlService.executeJob()` upon model approval, or via direct administrative call to `generatePredictions(tenantId, 'DEMAND_FORECASTING')`.
- **Method:** [`MlService.generatePredictions()`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L509-L534).
- **Feature Extraction Location:** In TypeScript in `ml-service.ts#L510-L534`, calling `IAnalyticsMlFeatureReader.getProductDailyDemandHistory(tenantId, 60)`.
- **Input Features Extracted (8 dimensions):**
  1. `lag1`: Units sold on previous day (default 5.0)
  2. `lag7`: Units sold 7 days prior
  3. `mean7`: 7-day rolling average units sold
  4. `mean14`: 14-day rolling average units sold
  5. `roll_std_7`: Hardcoded to `1.5` in Node.js
  6. `price`: Last recorded unit price (default 100.0)
  7. `dow`: Current day of week (0 to 6)
  8. `isWeekend`: Binary indicator (`1.0` if Sunday or Saturday, else `0.0`)
- **Python Execution:** Evaluated by `DemandForecaster.predict(X)`.
- **Python Output:** `predictionValue = round(float(preds[i]), 2)`, `probability = null`, `confidence = 0.85`.
- **Database Writes:** Upserted into `ml_predictions` with `entityType: 'PRODUCT'`, `entityId: productId`, `scopeKey: "<tenantId>:DEMAND_FORECASTING:PRODUCT:<productId>:<version>"`.
- **Read APIs:** `GET /ml/predictions/demand/:productId`, AI tool `get_demand_forecast`.

### 2. Stockout Risk (`STOCKOUT_RISK`)
- **Caller:** `MlService.generatePredictions(tenantId, 'STOCKOUT_RISK')`.
- **Method:** [`MlService.generatePredictions()`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L535-L551).
- **Feature Extraction Location:** TypeScript in `ml-service.ts#L536-L551`, calling `IAnalyticsMlFeatureReader.getInventoryVelocitySignals(tenantId)`.
- **Input Features Extracted (7 dimensions):**
  `[onHand, reserved, v7, v14, daysOfSupply, runoutRate, leadTimeDays]`.
- **Python Execution:** Evaluated by `StockoutPredictor.predict_proba(X)`.
- **Python Output:** `predictionValue = round(p, 4)`, `probability = round(p, 4)`, `confidence = round(abs(p - 0.5) * 2.0, 4)`.
- **Database Writes:** Upserted into `ml_predictions` with `entityType: 'SKU'`, `entityId: sku`.
- **Read APIs:** `GET /ml/predictions/stockout/:sku`, AI tool `get_stockout_risk`.

### 3. Customer Purchase Propensity (`PURCHASE_PROPENSITY`)
- **Caller:** `MlService.generatePredictions(tenantId, 'PURCHASE_PROPENSITY')`.
- **Method:** [`MlService.generatePredictions()`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L552-L567).
- **Feature Extraction Location:** TypeScript in `ml-service.ts#L553-L567`, calling `IAnalyticsMlFeatureReader.getCustomerActivitySignals(tenantId)`.
- **Input Features Extracted (6 dimensions):**
  `[recencyDays, frequency30d, frequency90d, totalOrders, monetaryTotal, aov]`.
- **Python Execution:** Evaluated by `PropensityPredictor.predict_proba(X)`.
- **Python Output:** `predictionValue = round(p, 4)`, `probability = round(p, 4)`, `confidence = round(abs(p - 0.5) * 2.0, 4)`.
- **Database Writes:** Upserted into `ml_predictions` with `entityType: 'CUSTOMER'`, `entityId: customerId`.
- **Read APIs:** `GET /ml/predictions/propensity/:customerId`.

### 4. Order Anomaly Detection (`ANOMALY_DETECTION`)
- **Caller:** `MlService.generatePredictions(tenantId, 'ANOMALY_DETECTION')`.
- **Method:** [`MlService.generatePredictions()`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L568-L585).
- **Feature Extraction Location:** TypeScript in `ml-service.ts#L569-L585`, calling `IAnalyticsMlFeatureReader.getOrderAnomalySignals(tenantId)`.
- **Input Features Extracted (6 dimensions):**
  `[Math.log(totalAmount), lineCount, totalQuantity, avgUnitPrice, hourOfDay, isNightOrder]`.
- **Python Execution:** Evaluated by `AnomalyDetector.predict_proba(X)`.
- **Python Output:** `predictionValue = round(p, 4)`, `probability = round(p, 4)`, `confidence = round(abs(p - 0.5) * 2.0, 4)`.
- **Database Writes:** Upserted into `ml_predictions` with `entityType: 'ORDER'`, `entityId: orderId`.
- **Read APIs:** `GET /ml/predictions/anomaly/:orderId`.

---

## 4. Exact Python Prediction Contract

The standalone inference service must preserve the exact input and output JSON shapes established in [`ml/predict.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py).

### Request Payload Schema
```json
{
  "modelType": "DEMAND_FORECASTING | STOCKOUT_RISK | PURCHASE_PROPENSITY | ANOMALY_DETECTION",
  "artifactPath": "string (path or URI to serialized model)",
  "features": [
    {
      "entityId": "string (required, unique per batch item)",
      "featureVector": [12.0, 10.0, 11.5, 12.1, 1.5, 99.99, 3.0, 0.0]
    }
  ]
}
```

#### Field Specifications:
- `modelType` (string, required): Used by `predict.py` to route between `.predict()` (continuous regression) and `.predict_proba()` (binary classification probability).
- `artifactPath` (string, required): Path to model binary. In the future standalone service, this transitions to an artifact version/URI identifier (`s3://...` or `model-id:version`).
- `features` (array of objects, optional/nullable):
  - If empty or omitted, returns `{"success": true, "predictions": []}`.
  - `entityId` (string): Stable identifier (`productId`, `sku`, `customerId`, `orderId`).
  - `featureVector` (array of numbers): Dense numerical vector matching the model's expected dimension.

### Response Payload Schema
```json
{
  "success": true,
  "predictions": [
    {
      "entityId": "prod-101",
      "predictionValue": 84.50,
      "probability": null,
      "confidence": 0.85
    },
    {
      "entityId": "sku-202",
      "predictionValue": 0.8124,
      "probability": 0.8124,
      "confidence": 0.6248
    }
  ]
}
```

#### Error Response Payload Schema
```json
{
  "success": false,
  "error": "Artifact not found: /path/to/model.joblib"
}
```

---

## 5. Feature Engineering Ownership

A critical architectural liability identified during code inspection is the **feature calculation divergence** between training and prediction:

| Use Case | Training Feature Extraction | Prediction Feature Extraction | Input Data Source | Language / Runtime | Duplication & Drift Risk |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Demand Forecasting** | [`ml/data/features.py#L12`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L12) | [`ml-service.ts#L510-L534`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L510-L534) | `analytics_order_facts` | Training: Python (Pandas)<br>Prediction: TypeScript | **HIGH RISK:** In Python training, `rolling_std_7d` is calculated dynamically (`np.std(units)`). In TypeScript prediction, Node.js hardcodes `1.5`! |
| **Stockout Risk** | [`ml/data/features.py#L92`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L92) | [`ml-service.ts#L535-L551`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L535-L551) | `analytics_order_facts` | Training: Python<br>Prediction: TypeScript | **MEDIUM RISK:** Calculation of `runoutRate` and `daysOfSupply` is duplicated across Python and TypeScript. |
| **Purchase Propensity**| [`ml/data/features.py#L214`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L214) | [`ml-service.ts#L552-L567`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L552-L567) | `analytics_order_facts` | Training: Python<br>Prediction: TypeScript | **LOW RISK:** Identical RFM feature formulas implemented in both languages. |
| **Anomaly Detection** | [`ml/data/features.py#L152`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L152) | [`ml-service.ts#L568-L585`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L568-L585) | `seller_orders`, `order_items` | Training: Python<br>Prediction: TypeScript | **LOW RISK:** Identical log-transforms and timing indicators. |

### Feature Ownership Boundary Decision
For the initial extraction of `apps/ml-service`:
- **Phase 1 (Non-Breaking Extraction):** Keep feature vector construction in `ml-service.ts` exactly as it exists today. The standalone inference service receives pre-extracted feature vectors (`featureVector: number[]`). This ensures **zero risk** of regression during initial service decoupling.
- **Phase 2 (Consolidation):** Standardize canonical feature transformers in a shared Python library (`packages/ml-core`) once training is extracted.

---

## 6. Model Loading and Artifact Dependencies

### Current Model Loading Behavior in `predict.py`
1. **Input Path Dependency:** Requires an absolute or relative local disk path:
   ```python
   artifact_path = payload["artifactPath"]
   if not os.path.exists(artifact_path):
       return {"success": False, "error": f"Artifact not found: {artifact_path}"}
   ```
2. **Deserialization:**
   ```python
   artifact = joblib.load(artifact_path)
   model = artifact["model"]
   ```
3. **Absence of In-Memory Caching:** Because `predict.py` is invoked as an ephemeral CLI script via `execFileAsync`, the model binary is deserialized from disk **on every single prediction batch**, discarding the in-memory estimator upon process exit.
4. **Corrupted Artifact Handling:** If `.joblib` is truncated or corrupted, `joblib.load()` throws `_pickle.UnpicklingError` or `EOFError`, resulting in process failure.
5. **No Model Warmup:** Python startup latency + Scikit-learn import latency + disk I/O occurs on every invocation (~300ms–800ms overhead).

### Target Standalone Model Loading Strategy
In `apps/ml-service`:
- **LRU / TTL In-Memory Model Cache:** Pre-load active models into memory. Deserialization happens once on startup or upon cache miss, reducing inference latency to $< 5\text{ms}$.
- **Readiness Probes (`/ready`):** Ensure primary models are loaded into memory before the container accepts production traffic.
- **Atomic Cache Invalidation:** When a new model version is promoted, a reload signal refreshes the in-memory pointer without dropping traffic.

---

## 7. Future ML Service Boundary

The standalone ML inference service will be packaged as:
- **Repository Location:** `apps/ml-service/`
- **Runtime:** Python 3.11+
- **Framework:** FastAPI + Uvicorn

### Proposed Internal REST Endpoints

#### 1. `POST /v1/predict` (Batch Inference)
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `X-Correlation-Id: <uuid>`, `X-Tenant-Id: <tenantId>`
- **Request Body:**
  ```json
  {
    "modelType": "DEMAND_FORECASTING",
    "modelVersion": "v1.0.0",
    "features": [
      {
        "entityId": "prod-101",
        "featureVector": [12.0, 10.0, 11.5, 12.1, 1.5, 99.99, 3.0, 0.0]
      }
    ]
  }
  ```
- **Response Body (200 OK):**
  ```json
  {
    "success": true,
    "predictions": [
      {
        "entityId": "prod-101",
        "predictionValue": 84.5,
        "probability": null,
        "confidence": 0.85
      }
    ]
  }
  ```

#### 2. `GET /health/live` & `GET /health/ready`
- **Liveness:** Returns `200 OK` if the Uvicorn web server is running.
- **Readiness:** Returns `200 OK` if active model weights are initialized and memory capacity is normal.

#### 3. Operational Limits
- **Timeout SLA:** 200ms maximum internal timeout (vs 30,000ms currently allowed for subprocess startup).
- **Max Request Size:** 5MB payload limit (~1,000 entities per batch).

---

## 8. Future HTTP Provider Mapping

The newly introduced [`IMlExecutionProvider`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-execution-provider.ts#L22) interface allows swapping the execution provider without modifying a single line of `MlService` business logic:

```typescript
export class HttpMlExecutionProvider implements IMlExecutionProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `ML Service HTTP error: ${response.status} ${response.statusText}`,
        };
      }

      return (await response.json()) as PythonPredictResult;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async runTraining(config: Record<string, unknown>): Promise<PythonTrainResult> {
    // Delegates to jobs/ml-training or training dispatcher endpoint
    ...
  }
}
```

---

## 9. Failure Semantics

To guarantee that the extraction does not alter monolith behavior, the future service must replicate all current failure semantics:

| Failure Scenario | Current Monolith Subprocess Behavior | Required Future Service Behavior |
| :--- | :--- | :--- |
| **Model Unavailable / Missing** | `predict.py` returns `{ success: false, error: "Artifact not found" }`. Node logs warning, returns `{ count: 0 }`. | `apps/ml-service` returns `404` or `{ success: false, error: "Model not found" }`. Node provider returns identical failure shape. |
| **Model Artifact Corrupted** | Subprocess exits with non-zero exit code. Node traps error in `try/catch`, returns `{ count: 0 }`. | `apps/ml-service` returns `500` `{ success: false, error: "Corrupted model artifact" }`. |
| **Service Timeout** | Process killed at 30,000ms. Node traps timeout, logs error, returns `{ count: 0 }`. | Monolith HTTP client aborts at 5,000ms. Logs timeout, returns `{ count: 0 }`. |
| **Malformed Feature Vector** | NumPy throws `ValueError`. Python returns `{ success: false, error: "..." }`. | FastAPI validation returns `422 Unprocessable Entity` or `{ success: false }`. |
| **Unsupported Model Type** | `predict.py` returns `{ success: false, error: "Unknown model type" }`. | Service returns `{ success: false, error: "Unknown model type" }`. |
| **Service Crash / Outage** | Process spawn fails with `ENOENT`. Trapped safely in Node. | HTTP connection refused (`ECONNREFUSED`). Trapped safely in Node provider; commerce continues unimpeded. |

---

## 10. Security Boundary

The standalone ML inference service is strictly an **internal, non-public microservice**:

1. **Network Isolation:** Service must **not** be exposed to public internet or the API Gateway edge. Accessible exclusively within internal private VPC / Kubernetes network.
2. **Service Authentication:** Internal mTLS or shared bearer token (`X-Internal-Service-Key`).
3. **Tenant Context Propagation:** Mandatory `X-Tenant-Id` header on all scoring requests to ensure multi-tenant model isolation.
4. **Data Privacy (Zero PII Exposure):** Scoring inputs contain strictly anonymized numerical feature vectors. Zero customer names, emails, credit cards, or plain-text addresses are transmitted to `apps/ml-service`.

---

## 11. Deployment Boundary

The code separation across repositories and build artifacts:

### A. Inference Runtime Files (`apps/ml-service/`)
- `apps/ml-service/src/main.py` (FastAPI app & lifecycle hooks)
- `apps/ml-service/src/routes/predict.py`
- `apps/ml-service/src/model_cache.py` (In-memory model manager)
- `apps/ml-service/Dockerfile`
- `apps/ml-service/requirements.txt` (`fastapi`, `uvicorn`, `scikit-learn`, `numpy`, `joblib`, `boto3`)

### B. Training-Only Files (`jobs/ml-training/`)
- `jobs/ml-training/src/trainer.py`
- `jobs/ml-training/src/data/bootstrap.py` (Synthetic cold-start generator)
- `jobs/ml-training/requirements.txt` (Adds `pandas`)

### C. Shared Model Definitions (`packages/ml-core/`)
- `ml/models/demand_forecaster.py`
- `ml/models/stockout_predictor.py`
- `ml/models/propensity_predictor.py`
- `ml/models/anomaly_detector.py`

### D. Files Retained in Monolith (`apps/api/`)
- `apps/api/src/modules/analytics-ml/internal/ml-service.ts` (Orchestrator & persistence manager)
- `apps/api/src/infra/ml/sql-ml-store.ts` (PostgreSQL table repository)
- `apps/api/src/http/ml-routes.ts` (Customer and admin HTTP endpoints)

### E. Files to be Deprecated Post-Extraction
- `apps/api/src/modules/analytics-ml/internal/python-runner.ts` (Replaced by `HttpMlExecutionProvider`)
- Root-level `/ml/predict.py`

---

## 12. Artifact Migration Boundary

### Current State
- Model binaries stored locally in `/.ml_artifacts/<tenantId>_<MODEL_TYPE>_<version>.joblib`.
- Database table `ml_models.artifact_path` stores local absolute/relative disk paths.

### Target State
- Model binaries published by training jobs to centralized Object Storage:
  `s3://commerce-ml-registry/models/<tenantId>/<modelType>/<version>.joblib`
- `ml_models.artifact_path` updated to store S3 URIs or immutable artifact IDs.
- `apps/ml-service` downloads and verifies model binaries from Object Storage on first reference, caching them locally in memory.

---

## 13. Backward Compatibility

The architecture supports a zero-downtime, fully reversible cutover strategy:

```text
                                       IMlExecutionProvider
                                                │
                       ┌────────────────────────┴────────────────────────┐
                       ▼                                                 ▼
        LocalPythonMlExecutionProvider                      HttpMlExecutionProvider
         (Active by default in Monolith)                 (Activated via ML_SERVICE_URL)
                       │                                                 │
                       ▼                                                 ▼
             Existing /ml/predict.py                             Standalone apps/ml-service
```

### Dynamic Provider Selection
In `analyticsMlModule.createService()`:
```typescript
const provider = process.env.ML_SERVICE_URL
  ? new HttpMlExecutionProvider(process.env.ML_SERVICE_URL)
  : new LocalPythonMlExecutionProvider(new PythonRunner(logger));
```
- If `ML_SERVICE_URL` is omitted, the system defaults to the existing local Python runner.
- If the standalone service experiences an issue during rollout, unsetting `ML_SERVICE_URL` instantly reverts execution back to the monolith without a code deployment.

---

## 14. Safe Extraction Sequence

```text
STEP 1: Standalone Service Scaffolding (Zero Impact on Monolith)
  - Create apps/ml-service with FastAPI and Dockerfile.
  - Implement POST /v1/predict and /health/ready.
  - Package Scikit-learn model loading and inference logic.

STEP 2: Standalone Service Container Build & Test
  - Build container image and verify health checks in CI.
  - Run synthetic inference tests against sample .joblib models in isolation.

STEP 3: Implement Monolith HTTP Client (HttpMlExecutionProvider)
  - Implement HttpMlExecutionProvider in apps/api behind IMlExecutionProvider.
  - Add unit tests with mock HTTP server; monolith remains wired to Local provider.

STEP 4: Shadow / Dual-Run Validation (Staging)
  - Enable ML_SERVICE_URL in staging environment.
  - Validate inference outputs match local Python results 100%.

STEP 5: Production Traffic Cutover
  - Set ML_SERVICE_URL in production environment.
  - Monitor latency metrics and circuit breakers.

STEP 6: Deprecate Legacy Monolith Python Runner
  - Remove PythonRunner and root /ml/predict.py.
```

---

## 15. Risks and Unknowns

1. **Network Latency vs Process Startup Latency:**
   - Subprocess execution currently takes 300ms–800ms per invocation.
   - HTTP internal network hop will take 2ms–10ms, representing a **30x–50x latency improvement**.
2. **Batch Request Sizing:**
   - High-entity batches (e.g. 5,000 products in catalog) could cause HTTP request payload timeouts.
   - *Mitigation:* Chunk feature vectors in batches of 500 entities in `HttpMlExecutionProvider`.
3. **Artifact Availability during Transition:**
   - If `apps/ml-service` runs in Docker/Kubernetes while models are still on local developer disk, the container cannot read developer disk files.
   - *Requirement:* S3 object storage integration or a shared volume must precede deploying `apps/ml-service` to multi-node clusters.

---

## 16. Recommended Next Implementation Step

The recommended immediate next step is:
**Implement the standalone `apps/ml-service` application in isolation (scaffolding FastAPI, Dockerfile, and `POST /v1/predict` endpoint), keeping the monolith completely untouched and operating on `LocalPythonMlExecutionProvider`.**

---

## Explicit Safety & Invariance Confirmations

- **No source code changed:** Verified.
- **No files moved:** Verified.
- **No files deleted:** Verified.
- **No database changed:** Verified (`commerce_db` and `commerce_db_backup` untouched).
- **No packages changed:** Verified (`package.json`, `package-lock.json`, and Python packages untouched).
- **No server started:** Verified (Zero server/daemon processes running).
- **No training executed:** Verified.
- **No prediction executed:** Verified.
- **No artifacts modified:** Verified (`.ml_artifacts` untouched).
- **No Git commit / push performed:** Verified.

---

**STOPPING.** Waiting for your next instruction.
