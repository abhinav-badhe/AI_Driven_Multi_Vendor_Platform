# ml/inference/engine.py
"""
Reusable Machine Learning Inference Engine.
Encapsulates model deserialization, input validation, and scoring semantics
for all supported model types without any CLI, subprocess, or transport dependencies.
"""
import os
from typing import Any, Dict, List

import joblib
import numpy as np

from typing import Any, Dict, List, Optional

SUPPORTED_MODEL_TYPES = {
    "DEMAND_FORECASTING",
    "STOCKOUT_RISK",
    "PURCHASE_PROPENSITY",
    "ANOMALY_DETECTION",
}


def resolve_artifact_path(artifact_path: str, base_dir: str = None) -> Optional[str]:
    """
    Resolves an artifact path or key into a verified existing filesystem path.
    Guarantees backward compatibility with:
      1. Legacy absolute paths (e.g. C:/.../.ml_artifacts/model.joblib)
      2. Environment-independent relative keys (e.g. .ml_artifacts/model.joblib, artifacts/model.joblib)
      3. Bare filenames (e.g. model.joblib)
    Guards against path traversal escaping the intended artifact root.
    """
    if not artifact_path or not isinstance(artifact_path, str) or not artifact_path.strip():
        return None

    cleaned = artifact_path.strip()

    # 1. Direct path check (handles legacy absolute paths and paths already relative to cwd)
    if os.path.exists(cleaned):
        return os.path.realpath(os.path.abspath(cleaned))

    # 2. Determine potential artifact roots to search
    roots = []
    env_root = os.getenv("ML_ARTIFACT_ROOT")
    if env_root:
        roots.append(os.path.realpath(os.path.abspath(env_root)))

    cwd = base_dir or os.getcwd()
    roots.append(os.path.realpath(os.path.abspath(os.path.join(cwd, ".ml_artifacts"))))
    roots.append(os.path.realpath(os.path.abspath(cwd)))

    # Clean traversal components
    norm = os.path.normpath(cleaned)
    parts = norm.split(os.sep)
    if parts and parts[0] in [".ml_artifacts", "artifacts"]:
        stripped_norm = os.sep.join(parts[1:])
    else:
        stripped_norm = norm

    # 3. Check stripped norm or bare filename inside roots
    candidates = [norm, stripped_norm, os.path.basename(cleaned)]
    for r in roots:
        for c in candidates:
            candidate_path = os.path.realpath(os.path.abspath(os.path.join(r, c)))
            if os.path.exists(candidate_path):
                # Ensure it doesn't escape the root
                try:
                    if os.path.commonpath([r, candidate_path]) == r:
                        return candidate_path
                except ValueError:
                    pass

    return None


def load_model_artifact(artifact_path: str) -> dict:
    """
    Load a serialized model artifact dictionary from local storage.
    Isolates artifact deserialization so a future artifact resolver
    (e.g., S3/remote cache) can be introduced without touching scoring logic.
    """
    resolved = resolve_artifact_path(artifact_path)
    if not resolved or not os.path.exists(resolved):
        raise FileNotFoundError(f"Artifact not found: {artifact_path}")
    return joblib.load(resolved)


class InferenceEngine:
    """
    Core stateless scoring engine for predictive commerce models.
    Supports scoring both from serialized artifact paths and directly
    from pre-loaded in-memory model instances.
    """

    def score_vectors(
        self,
        model: Any,
        model_type: str,
        features_input: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Score a batch of feature vectors against an in-memory model instance.
        Preserves exact prediction, probability, and confidence semantics.
        """
        if model_type not in SUPPORTED_MODEL_TYPES:
            raise ValueError(f"Unknown model type: {model_type}")

        if not features_input:
            return []

        vectors = [item["featureVector"] for item in features_input]
        X = np.array(vectors)

        results = []
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
        elif model_type in ["STOCKOUT_RISK", "PURCHASE_PROPENSITY", "ANOMALY_DETECTION"]:
            probas = model.predict_proba(X)
            for i, item in enumerate(features_input):
                row = np.asarray(probas[i]).ravel()
                # Binary classifiers emit [P(class 0), P(class 1)]; use the
                # positive-class probability, falling back to a single score.
                p = float(row[1]) if row.size > 1 else float(row[0])
                results.append({
                    "entityId": item["entityId"],
                    "predictionValue": round(p, 4),
                    "probability": round(p, 4),
                    "confidence": round(abs(p - 0.5) * 2.0, 4),
                })

        return results

    def predict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute prediction on an input payload matching the current JSON contract:
          {
            "artifactPath": str,
            "modelType": str,
            "features": list[{"entityId": str, "featureVector": list[float]}]
          }
        """
        artifact_path = payload.get("artifactPath")
        features_input = payload.get("features", [])
        model_type = payload.get("modelType")

        resolved_path = resolve_artifact_path(artifact_path) if artifact_path else None
        if not resolved_path or not os.path.exists(resolved_path):
            return {
                "success": False,
                "error": f"Artifact not found: {artifact_path}",
            }

        if model_type not in SUPPORTED_MODEL_TYPES:
            return {
                "success": False,
                "error": f"Unknown model type: {model_type}",
            }

        try:
            artifact = load_model_artifact(resolved_path)
            model = artifact["model"]
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to load artifact '{artifact_path}': {str(e)}",
            }

        if not features_input:
            return {"success": True, "predictions": []}

        try:
            predictions = self.score_vectors(model, model_type, features_input)
            return {
                "success": True,
                "predictions": predictions,
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
            }


# Shared default engine instance
_default_engine = InferenceEngine()


def generate_predictions(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Functional entry point for model inference matching the exact existing predict.py signature.
    Delegates to InferenceEngine while preserving existing error and return formats.
    """
    return _default_engine.predict(payload)
