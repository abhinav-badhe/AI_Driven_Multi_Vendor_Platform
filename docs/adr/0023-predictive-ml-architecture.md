# ADR 0023: Phase 13 Predictive Machine Learning Architecture

## Status

Accepted

## Context

Phase 13 introduces predictive machine learning capabilities on top of the multi-vendor commerce platform. The system requires three core predictive capabilities:

1. SKU/Product Demand Forecasting
2. Stockout Risk Probability Prediction
3. Customer Purchase Propensity Scoring

A fundamental non-negotiable architectural invariant is that ML is a **derived, optional intelligence layer**. It must never block, mutate, or become a synchronous dependency for any transactional domain (Cart/Checkout, Inventory, Orders, Payments, Settlement, Fulfillment, Catalog, Identity).

## Decisions

### 1. Context Boundary and Read-Only Contract

The ML bounded context (`modules/analytics-ml`) consumes data exclusively through an approved, tenant-scoped, typed read-only interface: `IAnalyticsMlFeatureReader`.

- `fetchProductDailyDemand(tenantId, skuOrProductId, lookbackDays)`
- `fetchInventoryVelocitySignals(tenantId, lookbackDays)`
- `fetchCustomerActivitySignals(tenantId, lookbackDays)`

ML code is strictly forbidden from querying transactional tables or internal analytics tables directly.

### 2. Python ML Runtime Isolation

The ML training and inference pipelines are implemented in Python (`ml/` directory) utilizing `scikit-learn`, `pandas`, `numpy`, and `joblib`.
Execution is orchestrated asynchronously via `PythonMlRunner`, which launches an isolated subprocess with timeout guarantees, clean tempfile lifecycle, and deterministic random seed configuration (`random_state=42`).

### 3. Bootstrap / Cold-Start Strategy

To handle situations where tenant commerce history is sparse or empty without faking successful training:

- When real sample counts are below defined minimum thresholds (`minSamples`: 14 for demand, 10 for stockout, 5 for propensity), the system falls back to explicitly generated synthetic data.
- The model records `dataSourceType: 'BOOTSTRAP'` (vs `'REAL'`) and `isSynthetic: true`.
- Models clearly expose their provenance in registry metadata and prediction records.

### 4. Deterministic Feature Engineering & Leakage Prevention

Feature extractors calculate rolling demand windows (7d, 14d, 30d), lag features (t-1, t-7), day-of-week one-hot signals, price velocity, and velocity ratios strictly prior to the forecast horizon $t$. Target variables represent future performance $[t, t+H]$ and are never fed into feature vectors.

### 5. Model Registry & Immutable Versions

Model versions follow the format `{useCase}-v{timestamp}` and progress through lifecycle states:
`TRAINING` -> `EVALUATING` -> `APPROVED` / `REJECTED` -> `RETIRED`.
Only one model version per `(tenantId, useCase)` can be `APPROVED` and active at any given time.
Models are immutable upon approval. Rollback to any previously approved version is supported.

### 6. Failure Isolation

- ML failures (service unavailable, training job failure, corrupted model artifact, evaluation rejection) do not affect transactional operations.
- Commerce workflows (checkout, payment, order creation, inventory allocation) function completely independently of ML.
- Prediction generation failures retry safely without producing duplicate records.

### 7. Recommendations Decoupling

Phase 12 Recommendations remains 100% deterministic and functional. Predictive ML exposes an optional `IMlSignalReader` interface that Phase 12 or future phases can query as ranking signals without introducing synchronous coupling.
