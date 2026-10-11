# Standalone ML Inference Service (`apps/ml-service`)

Stateless high-throughput microservice for predictive commerce ML scoring.

## Purpose
Exposes the core machine learning inference engine (`ml.inference.engine`) over an independent HTTP REST interface. Handles real-time and batch prediction for:
- Demand Forecasting (`DEMAND_FORECASTING`)
- Stockout Risk Prediction (`STOCKOUT_RISK`)
- Customer Purchase Propensity (`PURCHASE_PROPENSITY`)
- Order Anomaly Detection (`ANOMALY_DETECTION`)

> **Note on Artifact Storage:** During this stage of the migration, model artifacts are loaded from a local, configuration-restricted directory (`ML_ARTIFACT_ROOT`). Centralized object storage (e.g. S3/MinIO) will be introduced in a future deployment phase.

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Bind host address |
| `PORT` | `8000` | Port for the HTTP server |
| `ML_ARTIFACT_ROOT` | `<repo_root>/.ml_artifacts` | Root directory allowed for reading `.joblib` model artifacts. Enforces path-traversal prevention. |

---

## Endpoints

### 1. `GET /health`
Liveness check confirming that the service process is up.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "service": "ml-inference-service"
}
```

### 2. `GET /ready`
Readiness check confirming inference libraries (NumPy, Scikit-learn, Joblib) are available.

**Response (200 OK):**
```json
{
  "status": "ready",
  "service": "ml-inference-service",
  "artifactRootAccessible": true
}
```

### 3. `POST /v1/predict`
Executes batch scoring against a designated model artifact.

**Request Payload:**
```json
{
  "modelType": "DEMAND_FORECASTING",
  "artifactPath": "tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib",
  "features": [
    {
      "entityId": "prod-101",
      "featureVector": [12.0, 10.0, 11.5, 12.1, 1.5, 99.99, 3.0, 0.0]
    }
  ]
}
```

**Response Payload (200 OK):**
```json
{
  "success": true,
  "predictions": [
    {
      "entityId": "prod-101",
      "predictionValue": 84.50,
      "probability": null,
      "confidence": 0.85
    }
  ]
}
```

---

## How to Run Locally

From the repository root:
```bash
python -m uvicorn app.main:app --app-dir apps/ml-service --host 0.0.0.0 --port 8000
```

---

## Testing Command

Execute service unit and integration tests using Python's standard `unittest`:
```bash
python -m unittest discover -s apps/ml-service/tests -v
```
