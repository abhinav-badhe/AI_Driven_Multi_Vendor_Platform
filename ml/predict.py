# ml/predict.py
"""
Asynchronous Model Inference / Prediction Generation Entry Point.
Loads serialized model artifact, executes inference, and returns structured predictions.
"""
import argparse
import json
import os
import sys

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import joblib
import numpy as np


def generate_predictions(payload: dict) -> dict:
    artifact_path = payload["artifactPath"]
    features_input = payload.get("features", [])
    model_type = payload.get("modelType")

    if not os.path.exists(artifact_path):
        return {
            "success": False,
            "error": f"Artifact not found: {artifact_path}",
        }

    artifact = joblib.load(artifact_path)
    model = artifact["model"]

    if not features_input:
        return {"success": True, "predictions": []}

    results = []
    vectors = [item["featureVector"] for item in features_input]
    X = np.array(vectors)

    if model_type == "DEMAND_FORECASTING":
        preds = model.predict(X)
        for i, item in enumerate(features_input):
            val = float(preds[i])
            results.append({
                "entityId": item["entityId"],
                "predictionValue": round(val, 2),
                "probability": None,
                "confidence": 0.85,
            })
    elif model_type in ["STOCKOUT_RISK", "PURCHASE_PROPENSITY"]:
        probas = model.predict_proba(X)
        for i, item in enumerate(features_input):
            p = float(probas[i])
            results.append({
                "entityId": item["entityId"],
                "predictionValue": round(p, 4),
                "probability": round(p, 4),
                "confidence": round(abs(p - 0.5) * 2.0, 4),
            })
    else:
        return {"success": False, "error": f"Unknown model type: {model_type}"}

    return {
        "success": True,
        "predictions": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Predictive ML Predictor")
    parser.add_argument("--input-file", help="Path to input JSON file")
    parser.add_argument("--output-file", help="Path to output JSON file")
    args = parser.parse_args()

    if args.input_file:
        with open(args.input_file, "r", encoding="utf-8") as f:
            payload = json.load(f)
    else:
        payload = json.loads(sys.stdin.read())

    result = generate_predictions(payload)

    if args.output_file:
        with open(args.output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
