# ML MIGRATION READINESS AUDIT

> **Document Status:** Authoritative Source-Code Audit & Migration Readiness Report  
> **Phase:** Audit & Inspection (Read-Only Migration Readiness Phase)  
> **Baseline References:** Verified against [`CURRENT-MONOLITH-VALIDATED.md`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/CURRENT-MONOLITH-VALIDATED.md) and [`TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md)  
> **Safety Guarantee:** Pure audit artifact. Zero source files moved or modified, zero packages installed, zero database mutations, zero server/job processes executed.

---

## 1. Executive Summary

This audit assesses the migration readiness of the Machine Learning (ML) and Analytics subsystems within the multi-vendor e-commerce platform. Based on an exhaustive, file-by-file inspection of the active codebase, the reality of the ML implementation is characterized by a stark architectural contrast:

1. **Substantial Code Realization:** Unlike simple stubs or mock generators, the codebase contains real Scikit-learn algorithms, deterministic feature engineering pipelines, synthetic cold-start bootstrap generators, durable database-backed training jobs, retraining threshold policies, and a multi-tenant model registry.
2. **Severe Operational Liabilities:** The production viability of ML is fundamentally compromised by:
   - Root-level file coupling: Execution relies on [`ml/train.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/train.py) and [`ml/predict.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py) situated outside [`apps/`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps).
   - Local filesystem IPC: Inter-process communication operates via `child_process.execFileAsync` writing temporary JSON files to `os.tmpdir()`.
   - Local disk model artifacts: 231 `.joblib` model binaries (totaling ~83 MB) are saved directly to developer-local disk in [`/.ml_artifacts/`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/.ml_artifacts), making horizontal scaling across multi-container pods completely impossible.
   - Missing build & CI packaging: The Dockerfiles and GitHub CI workflow ([`.github/workflows/ci.yml`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/.github/workflows/ci.yml)) configure only Node.js 22, with zero Python runtime setup, dependency installation, or automated tests.
   - Heuristic recommendations: Product recommendations are **not** powered by Python ML models, but by an in-memory deterministic rule-based ranker in TypeScript ([`DeterministicRuleBasedRanker`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/recommendations/internal/recommendation-ranker.ts)).

The audit confirms that extracting ML into an autonomous microservice (`apps/ml-service`) and scheduled training job (`jobs/ml-training`) is technically feasible, highly urgent, and achievable without mutating existing transactional database schemas or altering frontend contracts.

---

## 2. Current ML Architecture

The current implementation bridges a TypeScript Fastify monolith to Python scripts via an ad-hoc local child process runner:

```text
                               +-------------------------------------------------------------------------+
                               |                            Fastify Monolith                             |
                               |                                                                         |
[Browser / Merchant Admin] --> | HTTP Routes: /ml/train, /ml/models, /ml/jobs, /ml/predictions, ...     |
                               |                                    |                                    |
                               |                             MlService (Node.js)                         |
                               |                     +--------------+--------------+                     |
                               |                     |                             |                     |
                               |             SqlMlStore (PostgreSQL)      IAnalyticsMlFeatureReader      |
                               |          (ml_models, ml_jobs, ...)                |                     |
                               +---------------------|-----------------------------|---------------------+
                                                     |                             | (Historical Facts)
                                                     |                             v
                                                     |                    AnalyticsRepository
                                                     |                   (analytics_order_facts)
                                                     |                             |
                                                     v                             v
                                             +-----------------------------------------+
                                             |       PythonRunner (Node.js child)      |
                                             |  - Writes input payload to os.tmpdir()  |
                                             |  - Spawns 'python ml/train.py'          |
                                             |  - Reads output JSON from os.tmpdir()   |
                                             +-----------------------------------------+
                                                                  |
                                                                  v (OS process execution)
                                             +-----------------------------------------+
                                             |               Python 3.10+              |
                                             |  - ml/train.py or ml/predict.py         |
                                             |  - Scikit-learn, NumPy, Pandas, Joblib  |
                                             |  - Reads/Writes /.ml_artifacts/*.joblib |
                                             +-----------------------------------------+
```

### Architectural Deficiencies Identified

1. **Per-Invocation Process Spawning:** Every prediction batch or training execution spawns an entirely new OS Python process. Python must start up, import large libraries (`pandas`, `scikit-learn`, `numpy`), deserialize models from disk, and terminate.
2. **Duplicated Feature Logic:** Feature preparation logic is partially duplicated:
   - Python implements feature extraction in [`ml/data/features.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py).
   - Node.js manually constructs identical feature vectors in TypeScript in [`apps/api/src/modules/analytics-ml/internal/ml-service.ts#L510-L585`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L510-L585) before invoking `predict.py`. Any schema drift between the two breaks scoring silently.
3. **Implicit Path Resolvers:** Node.js locates Python scripts by recursively walking directory parents looking for `existsSync(join(cur, 'ml', 'train.py'))` ([`python-runner.ts#L12-L33`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts#L12-L33)), which fails if compiled into standalone production bundles or non-standard directory layouts.

---

## 3. ML Entry Points

| Capability                          | File                                                                                                                                                                              | Function / Class                                | Purpose                                                                                                                                 | Caller                              | Input                                                                           | Output                                                                      |
| :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------- | :------------------------------------------------------------------------------ | :-------------------------------------------------------------------------- |
| **Training Pipeline**               | [`ml/train.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/train.py#L37)                                                      | `train_model(config: dict)`                     | Orchestrates cold-start check, feature extraction, model fit, train/val/test evaluation, serialization, and approval threshold decision | CLI entry `main()` or subprocess    | Configuration JSON (tenantId, modelType, records, hyperparameters, thresholds)  | Structured result JSON (success, metrics, modelId, artifactPath, status)    |
| **Inference Pipeline**              | [`ml/predict.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py#L18)                                                  | `generate_predictions(payload: dict)`           | Loads `.joblib` model artifact, casts feature vectors to `np.array`, generates point predictions or probability estimates               | CLI entry `main()` or subprocess    | Payload JSON (artifactPath, modelType, features: `[{entityId, featureVector}]`) | Predictions JSON (`[{entityId, predictionValue, probability, confidence}]`) |
| **Model Deserialization**           | [`ml/predict.py#L29`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py#L29)                                              | `joblib.load(artifact_path)`                    | Unpickles serialized model object and feature dictionary into Python heap memory                                                        | `generate_predictions()`            | Local file path string                                                          | Dictionary containing `model`, `feature_names`, `model_type`, `version`     |
| **Model Serialization**             | [`ml/train.py#L130`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/train.py#L130)                                                | `joblib.dump(..., artifact_path)`               | Persists trained model instance and feature schema to disk                                                                              | `train_model()`                     | Dictionary of model state, target disk path                                     | Byte stream written to `.joblib` binary file                                |
| **Feature Extraction (Demand)**     | [`ml/data/features.py#L12`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L12)                                  | `prepare_demand_features()`                     | Constructs lags (lag-1, lag-7), rolling means (7d, 14d), rolling std, price, day-of-week, and weekend indicators                        | `train_model()`                     | List of raw daily product demand dictionaries                                   | `(X: ndarray, y: ndarray, feature_names, metadata)`                         |
| **Feature Extraction (Stockout)**   | [`ml/data/features.py#L92`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L92)                                  | `prepare_stockout_features()`                   | Calculates available stock, daily runout rate, days of supply, velocities                                                               | `train_model()`                     | List of inventory velocity records                                              | `(X: ndarray, y: ndarray, feature_names, metadata)`                         |
| **Feature Extraction (Propensity)** | [`ml/data/features.py#L214`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L214)                                | `prepare_propensity_features()`                 | Computes recency, frequency (30d, 90d), total spend, and average order value (AOV)                                                      | `train_model()`                     | List of customer activity signal dictionaries                                   | `(X: ndarray, y: ndarray, feature_names, metadata)`                         |
| **Feature Extraction (Anomaly)**    | [`ml/data/features.py#L152`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py#L152)                                | `prepare_anomaly_features()`                    | Log-transforms order amounts, computes unit price ratios, flags off-hour placement                                                      | `train_model()`                     | List of order records                                                           | `(X: ndarray, y: ndarray, feature_names, metadata)`                         |
| **Cold-Start Generators**           | [`ml/data/bootstrap.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/bootstrap.py)                                        | `generate_bootstrap_*()`                        | Generates deterministic synthetic records when real historical samples fall below required training thresholds                          | `train_model()`                     | `(tenant_id, days/count, seed)`                                                 | Array of synthetic records flagged with `dataSourceType: "BOOTSTRAP"`       |
| **Node Child Process Runner**       | [`python-runner.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts)     | `PythonRunner.runTraining()`, `runPrediction()` | Writes temporary JSON files to `tmpdir()`, executes `python` with `execFileAsync`, parses stdout/JSON results, cleans up temp files     | `MlService`                         | TypeScript configuration / feature objects                                      | `Promise<PythonTrainResult>`, `Promise<PythonPredictResult>`                |
| **Async Training Orchestrator**     | [`ml-service.ts#L41`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L41)   | `MlService.enqueueTrainingJob()`                | Creates durable `PENDING` job in `ml_training_jobs`, triggers asynchronous background worker, returns immediately                       | HTTP POST `/ml/train`               | `TrainModelInputDto`                                                            | `TrainingJobRecord`                                                         |
| **Prediction Generator**            | [`ml-service.ts#L500`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/ml-service.ts#L500) | `MlService.generatePredictions()`               | Gathers active entity vectors from `featureReader`, invokes `pythonRunner.runPrediction()`, persists scores to `ml_predictions`         | Post-training trigger or admin call | `(tenantId, modelType)`                                                         | `{ count: number }`                                                         |

---

## 4. Model Inventory

The codebase contains exactly **4** verified ML models. No other models exist in Python.

### Model 1: Demand Forecaster

- **Model Type:** `DEMAND_FORECASTING`
- **Python Source:** [`ml/models/demand_forecaster.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/demand_forecaster.py)
- **Algorithm:** `RandomForestRegressor` (default: 50 estimators, max depth 8) or `Ridge` regression (alpha 1.0)
- **Input Features (8 features):**
  1. `lag_1_demand`: Units sold previous day
  2. `lag_7_demand`: Units sold 7 days prior
  3. `rolling_mean_7d`: 7-day moving average
  4. `rolling_mean_14d`: 14-day moving average
  5. `rolling_std_7d`: 7-day volatility
  6. `unit_price`: Average unit price
  7. `day_of_week`: Day of week index (0.0 to 6.0)
  8. `is_weekend`: Binary flag (1.0 for Saturday/Sunday, 0.0 otherwise)
- **Target ($y$):** Cumulative units sold over the upcoming horizon window (default: 7 days). Continuous positive float.
- **Preprocessing:** Chronological sort, window sliding with zero lookahead leakage, target summation across future horizon.
- **Output:** Predicted cumulative units sold (`np.maximum(0.0, preds)`).
- **Serialization Format:** Joblib `.joblib` binary payload holding model instance, feature name list, tenant ID, and seed.
- **Artifact Location:** `/.ml_artifacts/<tenantId>_DEMAND_FORECASTING_<version>.joblib`
- **Acceptance Gate:** Test RMSE $\le 100.0$ (configurable via `maxAcceptableRmse`).
- **Current API Consumer:** `GET /ml/predictions/demand/:productId`, `AnalyticsDashboard.tsx`, AI tool `get_demand_forecast`.

### Model 2: Stockout Risk Predictor

- **Model Type:** `STOCKOUT_RISK`
- **Python Source:** [`ml/models/stockout_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/stockout_predictor.py)
- **Algorithm:** `RandomForestClassifier` (default: 50 estimators, max depth 6) or `LogisticRegression`
- **Input Features (7 features):**
  1. `current_on_hand`: Units currently in stock
  2. `reserved_quantity`: Units allocated to open orders
  3. `velocity_7d`: 7-day sales velocity
  4. `velocity_14d`: 14-day sales velocity
  5. `days_of_supply`: Available inventory divided by daily velocity
  6. `runout_rate`: Horizon demand divided by available inventory
  7. `lead_time_days`: Vendor replenishment lead time
- **Target ($y$):** Binary classification: `1.0` if available stock $\le$ expected demand across horizon (7 days); `0.0` otherwise.
- **Preprocessing:** Ratio calculations, non-zero denominator protection (`max(1.0, available)`), stratified splitting.
- **Output:** Stockout probability (`predict_proba[:, 1]` $\in [0.0, 1.0]$) and confidence score ($|p - 0.5| \times 2.0$).
- **Serialization Format:** Joblib `.joblib` binary payload.
- **Artifact Location:** `/.ml_artifacts/<tenantId>_STOCKOUT_RISK_<version>.joblib`
- **Acceptance Gate:** Test Accuracy $\ge 0.50$ (configurable via `minAcceptableAccuracy`).
- **Current API Consumer:** `GET /ml/predictions/stockout/:sku`, `AnalyticsDashboard.tsx`, AI tool `get_stockout_risk`.

### Model 3: Customer Purchase Propensity

- **Model Type:** `PURCHASE_PROPENSITY`
- **Python Source:** [`ml/models/propensity_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/propensity_predictor.py)
- **Algorithm:** `RandomForestClassifier` (default: 50 estimators, max depth 6) or `LogisticRegression`
- **Input Features (6 features):**
  1. `recency_days`: Days elapsed since last completed purchase
  2. `frequency_30d`: Number of orders placed in last 30 days
  3. `frequency_90d`: Number of orders placed in last 90 days
  4. `total_orders`: Lifetime order count
  5. `monetary_total`: Lifetime gross spend
  6. `avg_order_value`: Average spend per order (`monetary_total / total_orders`)
- **Target ($y$):** Binary classification: `1.0` if customer shows high repurchase propensity in upcoming horizon (14 days); `0.0` otherwise.
- **Preprocessing:** Recency/frequency feature scaling, RFM scoring thresholds.
- **Output:** Purchase probability (`predict_proba[:, 1]` $\in [0.0, 1.0]$) and confidence score.
- **Serialization Format:** Joblib `.joblib` binary payload.
- **Artifact Location:** `/.ml_artifacts/<tenantId>_PURCHASE_PROPENSITY_<version>.joblib`
- **Acceptance Gate:** Test Accuracy $\ge 0.50$.
- **Current API Consumer:** `GET /ml/predictions/propensity/:customerId`, `AnalyticsDashboard.tsx`.

### Model 4: Order Anomaly Detector

- **Model Type:** `ANOMALY_DETECTION`
- **Python Source:** [`ml/models/anomaly_detector.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/anomaly_detector.py)
- **Algorithm:** `RandomForestClassifier` (default: 50 estimators, max depth 6) or `LogisticRegression`
- **Input Features (6 features):**
  1. `log_total_amount`: Natural log of order monetary total
  2. `line_count`: Number of distinct items in order
  3. `total_quantity`: Total quantity of units in order
  4. `avg_unit_price`: Average price per item (`total_amount / total_quantity`)
  5. `hour_of_day`: Hour order was placed (0 to 23)
  6. `is_night_order`: Binary flag (1.0 if placed between 23:00 and 06:00, 0.0 otherwise)
- **Target ($y$):** Binary classification: `1.0` if order exhibits extreme statistical outliers in value, volume, or timing; `0.0` otherwise.
- **Preprocessing:** Log-transformation, zero/negative guardrails, heuristic outlier tagging.
- **Output:** Anomaly probability score $\in [0.0, 1.0]$.
- **Serialization Format:** Joblib `.joblib` binary payload.
- **Artifact Location:** `/.ml_artifacts/<tenantId>_ANOMALY_DETECTION_<version>.joblib`
- **Acceptance Gate:** Test Accuracy $\ge 0.50$.
- **Current API Consumer:** `GET /ml/predictions/anomaly/:orderId`, `AnalyticsDashboard.tsx`.

---

## 5. Actual ML Use Cases

| Capability / Use Case       | Implemented in Python ML? | If YES: Code Location & Details                                                                                                                                                                                                                          | If NO: How is it Implemented?                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :-------------------------- | :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Demand Forecasting**      | **YES**                   | [`ml/models/demand_forecaster.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/demand_forecaster.py). Trained on historical daily order facts. Outputs predicted 7-day cumulative unit demand. | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Stockout Risk**           | **YES**                   | [`ml/models/stockout_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/stockout_predictor.py). Evaluates inventory on-hand, velocity, and runout rate. Outputs stockout probability.  | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Purchase Propensity**     | **YES**                   | [`ml/models/propensity_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/propensity_predictor.py). Evaluates RFM features. Outputs repeat transaction likelihood.                     | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Anomaly Detection**       | **YES**                   | [`ml/models/anomaly_detector.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/anomaly_detector.py). Evaluates gross value, line count, and order timing. Flags fraudulent or abnormal orders.  | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Product Recommendations** | **NO**                    | Not in Python. Zero recommendation code in `/ml`.                                                                                                                                                                                                        | Implemented purely in TypeScript in [`apps/api/src/modules/recommendations`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/recommendations/index.ts). Uses [`DeterministicRuleBasedRanker`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/recommendations/internal/recommendation-ranker.ts) with rule weights (co-purchase, popularity, category match). |
| **Price Prediction**        | **NO**                    | Not implemented.                                                                                                                                                                                                                                         | Does not exist anywhere in the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Price Elasticity**        | **NO**                    | Not implemented.                                                                                                                                                                                                                                         | Does not exist anywhere in the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Customer Churn**          | **NO**                    | Not implemented.                                                                                                                                                                                                                                         | Does not exist anywhere in the repository (the word "churn" in the repository only refers to high-write frequency database tables).                                                                                                                                                                                                                                                                                                                                                             |
| **Price Alerts**            | **NO**                    | Not an ML model.                                                                                                                                                                                                                                         | Implemented as a database watch table (`product_price_watches`) triggered by catalog price change events.                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 6. Node ↔ Python Contract

### Communication Protocol

The communication mechanism is strictly local filesystem IPC via child processes:

```text
Node.js (PythonRunner)
  | 1. Writes JSON payload to os.tmpdir() -> ml_train_in_<uuid>.json
  | 2. Spawns OS process: python ml/train.py --input-file <in> --output-file <out>
  | 3. Awaits child exit (timeout: 45s for train, 30s for predict)
  | 4. Reads output JSON from os.tmpdir() -> ml_train_out_<uuid>.json
  | 5. Cleans up temp files in finally block via Promise.allSettled(fs.unlink)
Python Process
```

### Request & Response Schemas

#### 1. Training Contract (`ml/train.py`)

- **Input JSON Payload Schema:**

```json
{
  "tenantId": "string (required)",
  "modelType": "DEMAND_FORECASTING | STOCKOUT_RISK | PURCHASE_PROPENSITY | ANOMALY_DETECTION",
  "version": "string (e.g. v1.1791478725773)",
  "seed": 42,
  "horizon": "7d | 14d",
  "records": [
    {
      "tenantId": "string",
      "productId": "string",
      "date": "YYYY-MM-DD",
      "unitsSold": 10,
      "orderCount": 5,
      "price": 100.0
    }
  ],
  "hyperparameters": {},
  "algorithm": "string (optional)",
  "maxAcceptableRmse": 100.0,
  "minAcceptableAccuracy": 0.5,
  "artifactDir": "string (optional, defaults to os.path.join(cwd, '.ml_artifacts'))"
}
```

- **Output JSON Payload Schema:**

```json
{
  "success": true,
  "modelId": "mdl-1a2b3c4d5e6f",
  "tenantId": "tenant-alpha",
  "modelType": "DEMAND_FORECASTING",
  "version": "v1.0.0",
  "status": "APPROVED | REJECTED | FAILED",
  "rejectionReason": "string | null",
  "algorithm": "RandomForestRegressor",
  "hyperparameters": {},
  "featureVersion": "v1",
  "trainingDatasetId": "ds-9f8e7d6c5b4a",
  "dataSourceType": "REAL | BOOTSTRAP",
  "predictionHorizon": "7d",
  "metrics": {
    "train": { "mae": 1.2, "rmse": 1.8, "r2": 0.85 },
    "validation": { "mae": 1.4, "rmse": 2.1, "r2": 0.81 },
    "test": { "mae": 1.5, "rmse": 2.2, "r2": 0.8 }
  },
  "sampleCount": 45,
  "artifactPath": "C:\\...\\.ml_artifacts\\tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib",
  "evaluatedAt": "2026-10-08T18:00:00.000Z",
  "approvedAt": "2026-10-08T18:00:00.000Z"
}
```

#### 2. Inference Contract (`ml/predict.py`)

- **Input JSON Payload Schema:**

```json
{
  "modelType": "DEMAND_FORECASTING",
  "artifactPath": "C:\\...\\.ml_artifacts\\tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib",
  "features": [
    {
      "entityId": "prod-101",
      "featureVector": [12.0, 10.0, 11.5, 12.1, 1.4, 99.99, 3.0, 0.0]
    }
  ]
}
```

- **Output JSON Payload Schema:**

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

### Operational Characteristics

- **Timeout Limits:**
  - Training: 45,000ms ([`python-runner.ts#L108`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts#L108))
  - Prediction: 30,000ms ([`python-runner.ts#L153`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts#L153))
- **Process Failure Handling:** Trapped in a `try/catch` block. Emits an error log and returns `{ success: false, status: 'FAILED', error: msg }`. Does not throw unhandled exceptions to Fastify routes.
- **File Cleanup:** Temp files in `os.tmpdir()` are unlinked inside a `finally` block using `Promise.allSettled`.
- **Concurrency Bottlenecks:** No throttling, queueing, or pooling exists at the OS process level. If 20 prediction requests arrive simultaneously, 20 distinct Python interpreter processes are spawned concurrently, creating severe CPU and memory contention.

---

## 7. ML Database Dependencies

The ML subsystem utilizes **4** dedicated PostgreSQL tables created in migrations [`0012_predictive_ml_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0012_predictive_ml_schema.sql) and [`0019_anomaly_prediction_entity_schema.sql`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/infra/database/migrations/0019_anomaly_prediction_entity_schema.sql):

### 1. `ml_models` (Model Registry)

- **Role:** Master catalog of trained models, validation metrics, approval states, and artifact locations.
- **Writers:** Written by `MlService.executeJob()` via `SqlMlStore.saveModel()`. Status updated by `SqlMlStore.setActiveModel()`.
- **Readers:** `MlService.getActiveModel()`, `MlService.listModels()`, `MlService.getModelById()`.
- **Critical Columns:** `id` (PK), `tenant_id`, `model_type`, `version`, `status` (`APPROVED`/`REJECTED`/`RETIRED`/`FAILED`), `algorithm`, `metrics` (JSONB), `artifact_path` (TEXT), `is_active` (BOOLEAN).
- **Constraints:**
  - `uq_ml_model_tenant_type_version UNIQUE (tenant_id, model_type, version)`
  - Partial unique index: `uq_ml_active_approved_model ON ml_models (tenant_id, model_type) WHERE is_active = TRUE` (guarantees exactly one active model per tenant and model type).
- **Runtime Dependency:**
  - **Inference:** Requires reading `ml_models` on startup or cache-miss to obtain the active `artifact_path`.
  - **Training:** Writes a new record upon job completion.

### 2. `ml_training_jobs` (Durable Job Log)

- **Role:** Asynchronous job execution tracking and deduplication log.
- **Writers:** Created by `MlService.enqueueTrainingJob()`. Updated (`RUNNING`, `COMPLETED`, `FAILED`) by `MlService.executeJob()`.
- **Readers:** `MlService.getTrainingJobById()`, `MlService.listTrainingJobs()`, background workers checking pending jobs.
- **Critical Columns:** `id` (PK), `tenant_id`, `model_type`, `trigger_type` (`MANUAL`/`SCHEDULED`/`MIN_DATA_THRESHOLD`), `status` (`PENDING`/`RUNNING`/`COMPLETED`/`FAILED`), `sample_count`, `model_id`, `error_message`, `config` (JSONB).
- **Constraints:**
  - Partial unique index: `uq_ml_active_training_job ON ml_training_jobs (tenant_id, model_type) WHERE status IN ('PENDING', 'RUNNING')` (prevents concurrent duplicate training runs for the same tenant and model).
- **Runtime Dependency:** Required only for training orchestration; never queried during real-time customer transactions.

### 3. `ml_predictions` (Derived Prediction Cache)

- **Role:** Persisted store of precomputed inference scores.
- **Writers:** Written by `MlService.generatePredictions()` via `SqlMlStore.savePredictions()`.
- **Readers:** `MlService.getDemandPrediction()`, `getStockoutPrediction()`, `getPropensityPrediction()`, `getAnomalyPrediction()`, `listPredictions()`.
- **Critical Columns:** `id` (PK), `scope_key` (VARCHAR UNIQUE), `tenant_id`, `model_id`, `model_version`, `model_type`, `entity_type` (`PRODUCT`/`SKU`/`CUSTOMER`/`ORDER`), `entity_id`, `prediction_value`, `probability`, `confidence`, `horizon`.
- **Constraints:**
  - `chk_ml_pred_entity CHECK (entity_type IN ('PRODUCT', 'SKU', 'CUSTOMER', 'ORDER'))` (updated by migration 0019).
  - Unique index: `uq_ml_prediction_entity_version UNIQUE (tenant_id, model_type, entity_id, model_version)`.
  - Upsert on conflict on `scope_key`.
- **Runtime Dependency:** Read by HTTP endpoints and AI tools. Completely decoupled from transactional order checkout.

### 4. `ml_retraining_policies` (Automated Lifecycle Policies)

- **Role:** Configuration of automated retraining trigger thresholds per tenant and model type.
- **Writers:** `MlService.saveRetrainingPolicy()`, `updateRetrainingPolicyStats()`.
- **Readers:** `MlService.getRetrainingPolicy()`, `evaluateAllRetrainingPolicies()`.
- **Critical Columns:** `id` (PK), `tenant_id`, `model_type`, `min_new_orders_threshold` (default: 10), `last_trained_order_count`, `last_trained_at`, `enabled` (BOOLEAN).
- **Constraints:** `uq_ml_retraining_policy UNIQUE (tenant_id, model_type)`.
- **Runtime Dependency:** Metadata only; evaluated by background scheduler timer.

---

## 8. Analytics Dependencies

The ML subsystem obtains historical data exclusively through the TypeScript interface [`IAnalyticsMlFeatureReader`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics/internal/analytics-models.ts#L348-L352), implemented by [`AnalyticsService`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics/internal/analytics-service.ts#L1010) and [`AnalyticsRepository`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics/internal/analytics-repository.ts#L830).

Python scripts **never** query PostgreSQL directly. Node.js queries the database, extracts the records, and serializes them into the input JSON file passed to Python.

### Exact Data Sources Queried

```text
+-----------------------------------+-----------------------------------------+----------------------------------------------+
| ML Model                          | Feature Reader Method                   | Source Database Table Queried                |
+-----------------------------------+-----------------------------------------+----------------------------------------------+
| DEMAND_FORECASTING                | getProductDailyDemandHistory()          | analytics_order_facts (Analytics Fact Table) |
| STOCKOUT_RISK                     | getInventoryVelocitySignals()           | analytics_order_facts (Analytics Fact Table) |
| PURCHASE_PROPENSITY               | getCustomerActivitySignals()            | analytics_order_facts (Analytics Fact Table) |
| ANOMALY_DETECTION                 | getOrderAnomalySignals()                | seller_orders, order_items (Transactional!)   |
+-----------------------------------+-----------------------------------------+----------------------------------------------+
```

### Architectural Findings

1. **Fact Table Alignment:** Three out of four models (`DEMAND_FORECASTING`, `STOCKOUT_RISK`, `PURCHASE_PROPENSITY`) query `analytics_order_facts`. This adheres to clean architectural boundaries because ML reads read-model facts rather than transactional tables.
2. **Transactional Boundary Violation:** `getOrderAnomalySignals()` queries `seller_orders` and `order_items` directly via SQL join ([`analytics-repository.ts#L973-L986`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics/internal/analytics-repository.ts#L973-L986)). In a distributed microservices architecture where `orders` is an independent service with its own database, `AnalyticsRepository` cannot run joins across `seller_orders` and `order_items`. Anomaly signals must instead be built from ingested `order.placed` domain events.

---

## 9. Model Artifact Inventory

An inspection of the local directory [`/.ml_artifacts/`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/.ml_artifacts) reveals:

- **Total Binary Files:** **231** `.joblib` files.
- **Total Directory Size:** **~83.2 MB**.
- **Naming Convention:** `<safeTenantId>_<MODEL_TYPE>_<version>.joblib`
  - Examples:
    - `tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib` (321.6 KB)
    - `tenant-alpha_STOCKOUT_RISK_v1.0.0.joblib` (38.2 KB)
    - `tenant-alpha_DEMAND_FORECASTING_v1.1791478767829.joblib` (321.6 KB)
    - `tenant-beta_DEMAND_FORECASTING_v1.1791478720435.joblib` (321.6 KB)
    - `tenant-multi_STOCKOUT_RISK_v1.1791478767830.joblib` (38.2 KB)
    - `tenant-pending_DEMAND_FORECASTING_v1.1791478725773.joblib` (321.6 KB)
- **Model Sizes by Type:**
  - `DEMAND_FORECASTING`: ~321 KB to 338 KB (RandomForest with 50 trees). Cold-start initial stub is ~34 KB.
  - `STOCKOUT_RISK`: ~38.2 KB.
  - `PURCHASE_PROPENSITY`: ~38.2 KB.
  - `ANOMALY_DETECTION`: ~38.2 KB.
- **Tenant Partitioning:** Tenant IDs are explicitly baked into the filename prefix (`tenant-alpha_`, `tenant-beta_`, `tenant-multi_`, `tenant-pending_`).
- **Absence of Sidecar Metadata:** There are **zero** JSON metadata files, model cards, or checksum files in `/.ml_artifacts`. All model provenance, evaluation metrics, and hyperparameters exist exclusively in the PostgreSQL `ml_models` table.
- **Artifact Accumulation:** Every test run that executes `service.processNextPendingJob()` writes a new timestamped `.joblib` file (e.g. `v1.1791478767829`). There is currently no pruning, retention policy, or garbage collection for obsolete disk artifacts.

---

## 10. Python Dependencies

### Dependency Inventory ([`ml/requirements.txt`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/requirements.txt))

```text
joblib>=1.3
numpy>=1.26
pandas>=2.0
scikit-learn>=1.3
```

### Analysis of Dependency Sets

#### Inference Minimum Set

- **Packages:** `joblib`, `numpy`, `scikit-learn`.
- **Rationale:** `ml/predict.py` unpickles the Scikit-learn estimator via `joblib.load()` and converts the input vectors using `np.array()`. It **does not import Pandas**.
- **Target Container Footprint:** A lightweight Python container (~150MB) with FastAPI, Uvicorn, NumPy, Scikit-learn, and Joblib.

#### Training Minimum Set

- **Packages:** `joblib`, `numpy`, `pandas`, `scikit-learn`.
- **Rationale:** `ml/train.py` relies on `pandas` for time-series feature engineering (rolling means, standard deviations, shift operations, and product groupings in `features.py`).
- **Target Job Footprint:** Standard Python batch image containing Pandas and Scikit-learn.

---

## 11. Production Packaging Readiness

To transition `/ml` into [`apps/ml-service`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md#L41) and [`jobs/ml-training`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/TARGET-ARCHITECTURE-AND-DEPLOYMENT-DESIGN.md#L48), the codebase is categorized as follows:

### 1. Files That Can Move Directly (Low Refactoring)

- [`ml/models/demand_forecaster.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/demand_forecaster.py) $\rightarrow$ Clean Scikit-learn class. Can move directly into shared Python package or training/inference code.
- [`ml/models/stockout_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/stockout_predictor.py) $\rightarrow$ Pure model class. Can move directly.
- [`ml/models/propensity_predictor.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/propensity_predictor.py) $\rightarrow$ Pure model class. Can move directly.
- [`ml/models/anomaly_detector.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/models/anomaly_detector.py) $\rightarrow$ Pure model class. Can move directly.
- [`ml/data/bootstrap.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/bootstrap.py) $\rightarrow$ Pure data generator. Belongs exclusively to training (`jobs/ml-training`).

### 2. Files Requiring Refactoring

- [`ml/predict.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/predict.py) $\rightarrow$ Currently a CLI script reading `sys.stdin` or `--input-file`. Must be refactored into a persistent FastAPI application exposing `POST /v1/predict` with in-memory model caching.
- [`ml/train.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/train.py) $\rightarrow$ Hardcodes local path `os.path.join(os.getcwd(), ".ml_artifacts")`. Must be refactored to stream serialized model artifacts to S3 Object Storage (`boto3`) and publish model metadata.
- [`ml/data/features.py`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/ml/data/features.py) $\rightarrow$ Feature logic is isolated for training, but inference feature extraction is currently hardcoded inside TypeScript (`ml-service.ts#L510`). Inference feature preparation must be consolidated.
- [`apps/api/src/modules/analytics-ml/internal/python-runner.ts`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts) $\rightarrow$ Must be replaced by an HTTP/gRPC client calling `apps/ml-service`.

---

## 12. API Compatibility

The existing external and internal HTTP APIs must retain 100% contract compatibility during and after migration:

| Route                            | HTTP Method | Owning Module  | Current Implementation                                | Frontend Consumer                                     | Target Microservice Destination                                        |
| :------------------------------- | :---------- | :------------- | :---------------------------------------------------- | :---------------------------------------------------- | :--------------------------------------------------------------------- |
| `/ml/train`                      | `POST`      | `analytics-ml` | `MlService.enqueueTrainingJob()` enqueues durable job | `AnalyticsDashboard.tsx` (`trainModel`)               | `apps/gateway` $\rightarrow$ `apps/analytics-service` / Job Dispatcher |
| `/ml/retrain`                    | `POST`      | `analytics-ml` | `MlService.retrainIfEligible()`                       | `AnalyticsDashboard.tsx` (`retrainModel`)             | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/retrain/evaluate-all`       | `POST`      | `analytics-ml` | `MlService.evaluateAllRetrainingPolicies()`           | Admin trigger                                         | Scheduled Cron / Worker                                                |
| `/ml/models/:modelId/rollback`   | `POST`      | `analytics-ml` | `MlService.rollbackModel()` updates active pointer    | `AnalyticsDashboard.tsx` (`rollbackModel`)            | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/models`                     | `GET`       | `analytics-ml` | `MlService.listModels()`                              | `AnalyticsDashboard.tsx` (`getMlModels`)              | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/models/:modelId`            | `GET`       | `analytics-ml` | `MlService.getModelById()`                            | Admin model detail                                    | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/jobs`                       | `GET`       | `analytics-ml` | `MlService.listTrainingJobs()`                        | `AnalyticsDashboard.tsx` (`listTrainingJobs`)         | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/jobs/:jobId`                | `GET`       | `analytics-ml` | `MlService.getTrainingJobById()`                      | `AnalyticsDashboard.tsx` (`getTrainingJob`)           | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/predictions/demand/:id`     | `GET`       | `analytics-ml` | `MlService.getDemandPrediction()` reads cache         | `AnalyticsDashboard.tsx`, AI tools                    | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/predictions/stockout/:sku`  | `GET`       | `analytics-ml` | `MlService.getStockoutPrediction()` reads cache       | `AnalyticsDashboard.tsx`, AI tools                    | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/predictions/propensity/:id` | `GET`       | `analytics-ml` | `MlService.getPropensityPrediction()` reads cache     | `AnalyticsDashboard.tsx`                              | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/predictions/anomaly/:id`    | `GET`       | `analytics-ml` | `MlService.getAnomalyPrediction()` reads cache        | `AnalyticsDashboard.tsx`                              | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/predictions`                | `GET`       | `analytics-ml` | `MlService.listPredictions()`                         | `AnalyticsDashboard.tsx` (`listPredictions`)          | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |
| `/ml/policies/:modelType`        | `GET`/`PUT` | `analytics-ml` | `MlService.get/saveRetrainingPolicy()`                | `AnalyticsDashboard.tsx` (`get/saveRetrainingPolicy`) | `apps/gateway` $\rightarrow$ `apps/analytics-service`                  |

---

## 13. Migration Risk Analysis

Based on current source code inspections, the following concrete risks have been identified:

1. **Path-Traversal Failure upon Moving Files:**
   - **Risk:** [`python-runner.ts#L12-L33`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/internal/python-runner.ts#L12-L33) traverses parent directories searching for `ml/train.py`. If `/ml` is moved or deleted before the runner is decoupled, `findProjectRoot()` fails, crashing all ML operations.
2. **Missing Python in Target CI/CD / Docker:**
   - **Risk:** The Dockerfile and `.github/workflows/ci.yml` do not install Python or Scikit-learn. If tests run in an environment without a global Python installation, training and prediction fail.
3. **Multi-Container Artifact Invisibility:**
   - **Risk:** `ml_models.artifact_path` points to local files like `C:\...\.ml_artifacts\tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib`. In any containerized environment, Pod A cannot read a model written to Pod A's local ephemeral filesystem from Pod B.
4. **Cold-Start Drift & Synthetic Labels:**
   - **Risk:** Bootstrap generators create synthetic data when real order count is $< 20$. If a newly extracted service switches to real training data prematurely, models will fail acceptance thresholds.
5. **Entity Type Check Constraint:**
   - **Risk:** Migration 0012 initially restricted `entity_type` to `PRODUCT`, `SKU`, `CUSTOMER`. Migration 0019 added `ORDER`. Any extracted service running against an unmigrated test database will fail with check constraint violations on anomaly predictions.

---

## 14. Current → Target File Mapping

| Current File Path                                             | Target File Path                                                                  | Migration Action | Detailed Rationale                                                                                  |
| :------------------------------------------------------------ | :-------------------------------------------------------------------------------- | :--------------- | :-------------------------------------------------------------------------------------------------- |
| `ml/train.py`                                                 | `jobs/ml-training/src/trainer.py`                                                 | **REFACTOR**     | Replace local disk outputs with S3 upload and publish `model.trained.v1` event.                     |
| `ml/predict.py`                                               | `apps/ml-service/src/main.py`                                                     | **REFACTOR**     | Convert CLI script into FastAPI web application with resident in-memory model cache.                |
| `ml/models/*.py`                                              | `packages/ml-core/ml_core/models/*.py`                                            | **MOVE**         | Pure Python model definitions shared across training and inference.                                 |
| `ml/data/bootstrap.py`                                        | `jobs/ml-training/src/data/bootstrap.py`                                          | **MOVE**         | Cold-start generation is only required during training.                                             |
| `ml/data/features.py`                                         | `packages/ml-core/ml_core/data/features.py`                                       | **MOVE**         | Canonical feature transformation logic shared between training and inference.                       |
| `ml/requirements.txt`                                         | Split: `apps/ml-service/requirements.txt` and `jobs/ml-training/requirements.txt` | **SPLIT**        | Separate lightweight inference requirements from full training stack (Pandas).                      |
| `/.ml_artifacts/*.joblib`                                     | `s3://commerce-ml-registry/models/`                                               | **REPLACE**      | Replace 231 local files with centralized S3 object store. Local files to be deleted after backfill. |
| `apps/api/src/modules/analytics-ml/internal/python-runner.ts` | `apps/api/src/modules/analytics-ml/internal/ml-client.ts`                         | **REPLACE**      | Replace `execFileAsync` child process spawner with HTTP/gRPC client targeting `apps/ml-service`.    |
| `apps/api/src/modules/analytics-ml/*`                         | `apps/analytics-service/src/*`                                                    | **MOVE**         | Analytics read-model and ML registry orchestration will become the autonomous analytics service.    |
| `apps/api/src/infra/ml/sql-ml-store.ts`                       | `apps/analytics-service/src/infra/sql-ml-store.ts`                                | **MOVE**         | Repository for `ml_models`, `ml_jobs`, `ml_predictions` moves with Analytics.                       |

---

## 15. Smallest Safe First Implementation

The safest, non-breaking, completely reversible first step is:

### Step: Create an Abstraction Interface over `PythonRunner`

1. Introduce an `IMlExecutionProvider` interface in [`apps/api/src/modules/analytics-ml`](file:///c:/Users/Abhinav/Documents/Project2/ai-driven-multi-vendor-predictive-ecom-platform/apps/api/src/modules/analytics-ml/index.ts).
2. Refactor `PythonRunner` to implement `IMlExecutionProvider` (maintaining existing local process behavior by default).
3. Implement a secondary `HttpMlExecutionProvider` that sends requests to an external URL if `ML_SERVICE_URL` is set in `.env`.
4. **Why this is the safest first step:**
   - Requires zero file movements.
   - Requires zero database changes.
   - Does not touch frontend or core commerce.
   - If `ML_SERVICE_URL` is omitted, the monolith functions exactly as it does today.
   - Allows `apps/ml-service` to be built and containerized in isolation and validated before touching any monolith code.

---

## 16. Questions / Unknowns

1. **Object Storage Selection:** Will production use AWS S3, Google Cloud Storage, Azure Blob Storage, or self-hosted MinIO for model artifacts?
2. **Inference Network Protocol:** Should `apps/ml-service` expose REST (FastAPI) or gRPC (Protobuf)? _Recommendation: REST with HTTP/2 internally for simpler debugging, transitioning to gRPC if P99 latency SLA requires it._
3. **Training Execution Platform:** Will training jobs run as Kubernetes `CronJobs`, AWS ECS tasks, or Temporal workflows?
4. **Model Artifact Backfill:** Should the existing 231 `.joblib` files in `/.ml_artifacts/` be uploaded to object storage during migration, or should the active models be retrained cleanly from scratch?

---

## 17. Recommended Implementation Sequence

```text
PHASE 1: Interface Decoupling (Monolith Safe)
  |  - Introduce IMlExecutionProvider in Node.js
  |  - Abstract PythonRunner behind the interface
  v
PHASE 2: Standalone ML Inference Service (apps/ml-service)
  |  - Build containerized FastAPI service
  |  - Implement model pre-loading from S3/local cache
  |  - Implement POST /v1/predict endpoints
  v
PHASE 3: Dual-Mode Validation (Shadow Testing)
  |  - Route prediction calls via HttpMlExecutionProvider to ml-service
  |  - Validate latency, accuracy, and error handling
  v
PHASE 4: Standalone Training Job (jobs/ml-training)
  |  - Containerize training pipeline
  |  - Upload .joblib artifacts to S3 with signed metadata
  v
PHASE 5: Remove /ml from Monolith
     - Delete legacy child_process runner
     - Purge /.ml_artifacts from local developer disks
```
