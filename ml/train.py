# ml/train.py
"""
Asynchronous Model Training Entry Point.
Executes data preparation, bootstrap check, deterministic training, validation, testing,
evaluation, model serialization, and status decision (APPROVED / REJECTED).
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import joblib

from ml.data.bootstrap import (
    generate_bootstrap_demand,
    generate_bootstrap_propensity,
    generate_bootstrap_stockout,
)
from ml.data.features import (
    prepare_demand_features,
    prepare_propensity_features,
    prepare_stockout_features,
)
from ml.models.demand_forecaster import DemandForecaster
from ml.models.propensity_predictor import PropensityPredictor
from ml.models.stockout_predictor import StockoutPredictor


def train_model(config: dict) -> dict:
    tenant_id = config["tenantId"]
    model_type = config["modelType"]
    version = config.get("version", "v1.0.0")
    seed = int(config.get("seed", 42))
    horizon_str = config.get("horizon", "7d")
    horizon_days = int("".join(filter(str.isdigit, horizon_str)) or "7")
    records = config.get("records", [])
    hyperparameters = config.get("hyperparameters", {})
    artifact_dir = config.get("artifactDir", os.path.join(os.getcwd(), ".ml_artifacts"))
    os.makedirs(artifact_dir, exist_ok=True)

    # 1. Cold start / bootstrap decision
    min_required_records = {
        "DEMAND_FORECASTING": 20,
        "STOCKOUT_RISK": 10,
        "PURCHASE_PROPENSITY": 10,
    }.get(model_type, 10)

    if len(records) < min_required_records:
        data_source_type = "BOOTSTRAP"
        if model_type == "DEMAND_FORECASTING":
            records = generate_bootstrap_demand(tenant_id, days=50, seed=seed)
        elif model_type == "STOCKOUT_RISK":
            records = generate_bootstrap_stockout(tenant_id, count=35, seed=seed)
        elif model_type == "PURCHASE_PROPENSITY":
            records = generate_bootstrap_propensity(tenant_id, count=45, seed=seed)
    else:
        data_source_type = "REAL"

    dataset_id = f"ds-{uuid.uuid4().hex[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()

    # 2. Feature engineering & Target preparation
    if model_type == "DEMAND_FORECASTING":
        X, y, feature_names, _ = prepare_demand_features(records, horizon_days=horizon_days)
        algorithm = config.get("algorithm", "RandomForestRegressor")
        model = DemandForecaster(algorithm=algorithm, seed=seed, **hyperparameters)
    elif model_type == "STOCKOUT_RISK":
        X, y, feature_names, _ = prepare_stockout_features(records, horizon_days=horizon_days)
        algorithm = config.get("algorithm", "RandomForestClassifier")
        model = StockoutPredictor(algorithm=algorithm, seed=seed, **hyperparameters)
    elif model_type == "PURCHASE_PROPENSITY":
        X, y, feature_names, _ = prepare_propensity_features(records, horizon_days=horizon_days)
        algorithm = config.get("algorithm", "RandomForestClassifier")
        model = PropensityPredictor(algorithm=algorithm, seed=seed, **hyperparameters)
    else:
        raise ValueError(f"Unsupported model type: {model_type}")

    if len(X) < 5:
        return {
            "success": False,
            "error": f"Insufficient feature samples after extraction: {len(X)}",
            "modelType": model_type,
            "status": "FAILED",
        }

    # 3. Train and Evaluate
    train_metrics, val_metrics, test_metrics = model.train_and_evaluate(X, y, feature_names)

    # 4. Configurable Acceptance Criteria
    # If criteria met -> APPROVED; else REJECTED
    is_approved = False
    rejection_reason = None

    if model_type == "DEMAND_FORECASTING":
        # Regression acceptance: RMSE reasonable (e.g. <= 100.0)
        max_rmse = float(config.get("maxAcceptableRmse", 100.0))
        if test_metrics["rmse"] <= max_rmse:
            is_approved = True
        else:
            rejection_reason = f"Test RMSE {test_metrics['rmse']:.2f} exceeded threshold {max_rmse:.2f}"
    else:
        # Classification acceptance: Accuracy >= 0.50
        min_acc = float(config.get("minAcceptableAccuracy", 0.50))
        if test_metrics["accuracy"] >= min_acc:
            is_approved = True
        else:
            rejection_reason = f"Test Accuracy {test_metrics['accuracy']:.2f} fell below threshold {min_acc:.2f}"

    model_status = "APPROVED" if is_approved else "REJECTED"

    # 5. Model Serialization
    safe_tenant = tenant_id.replace("/", "_").replace("\\", "_")
    artifact_filename = f"{safe_tenant}_{model_type}_{version}.joblib"
    artifact_path = os.path.join(artifact_dir, artifact_filename)
    joblib.dump({
        "model": model,
        "feature_names": feature_names,
        "model_type": model_type,
        "version": version,
        "tenant_id": tenant_id,
        "seed": seed,
    }, artifact_path)

    model_id = f"mdl-{uuid.uuid4().hex[:12]}"

    return {
        "success": True,
        "modelId": model_id,
        "tenantId": tenant_id,
        "modelType": model_type,
        "version": version,
        "status": model_status,
        "rejectionReason": rejection_reason,
        "algorithm": algorithm,
        "hyperparameters": hyperparameters,
        "featureVersion": "v1",
        "trainingDatasetId": dataset_id,
        "dataSourceType": data_source_type,
        "predictionHorizon": horizon_str,
        "metrics": {
            "train": train_metrics,
            "validation": val_metrics,
            "test": test_metrics,
        },
        "sampleCount": len(X),
        "artifactPath": artifact_path,
        "evaluatedAt": now_iso,
        "approvedAt": now_iso if is_approved else None,
    }


def main():
    parser = argparse.ArgumentParser(description="Predictive ML Model Trainer")
    parser.add_argument("--input-file", help="Path to input JSON config file")
    parser.add_argument("--output-file", help="Path to output JSON result file")
    args = parser.parse_args()

    if args.input_file:
        with open(args.input_file, "r", encoding="utf-8") as f:
            config = json.load(f)
    else:
        config = json.loads(sys.stdin.read())

    result = train_model(config)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
