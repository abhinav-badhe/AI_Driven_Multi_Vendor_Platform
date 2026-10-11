# apps/ml-service/tests/test_api.py
"""
Service-level integration tests for the Standalone ML Inference Service (FastAPI).
Uses Starlette/FastAPI TestClient with synthetic in-memory test artifacts (zero production disk models).
"""
import os
import shutil
import sys
import tempfile
import unittest

import joblib
import numpy as np
from starlette.testclient import TestClient

# Ensure repo root and app directory are on sys.path
REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from app.config import settings
from app.main import app


class MockRegressor:
    def predict(self, X):
        return np.array([float(row[0]) * 3.0 for row in X])


class MockClassifier:
    def predict_proba(self, X):
        results = []
        for row in X:
            p = min(1.0, max(0.0, float(row[0]) / 100.0))
            results.append([1.0 - p, p])
        return np.array(results)


class TestMlInferenceServiceApi(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.mkdtemp(prefix="ml_service_test_")
        self.orig_artifact_root = settings.artifact_root
        settings.artifact_root = self.temp_dir

    def tearDown(self):
        settings.artifact_root = self.orig_artifact_root
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_artifact(self, filename: str, model):
        path = os.path.join(self.temp_dir, filename)
        joblib.dump({"model": model, "model_type": "TEST"}, path)
        return filename

    def test_get_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["service"], settings.service_name)

    def test_get_ready(self):
        response = self.client.get("/ready")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ready")
        self.assertTrue(data["artifactRootAccessible"])

    def test_predict_demand_forecasting_success(self):
        filename = self._create_artifact("demand_v1.joblib", MockRegressor())
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": filename,
            "features": [
                {"entityId": "prod-101", "featureVector": [10.0, 5.0]},
                {"entityId": "prod-102", "featureVector": [20.0, 8.0]},
            ],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["predictions"]), 2)

        p1 = data["predictions"][0]
        self.assertEqual(p1["entityId"], "prod-101")
        self.assertEqual(p1["predictionValue"], 30.0)
        self.assertIsNone(p1["probability"])
        self.assertEqual(p1["confidence"], 0.85)

        p2 = data["predictions"][1]
        self.assertEqual(p2["entityId"], "prod-102")
        self.assertEqual(p2["predictionValue"], 60.0)

    def test_predict_stockout_risk_success(self):
        filename = self._create_artifact("stockout_v1.joblib", MockClassifier())
        payload = {
            "modelType": "STOCKOUT_RISK",
            "artifactPath": filename,
            "features": [
                {"entityId": "sku-abc", "featureVector": [75.0]},
            ],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["predictions"]), 1)

        p = data["predictions"][0]
        self.assertEqual(p["entityId"], "sku-abc")
        self.assertEqual(p["predictionValue"], 0.75)
        self.assertEqual(p["probability"], 0.75)
        self.assertEqual(p["confidence"], 0.5)

    def test_predict_purchase_propensity_success(self):
        filename = self._create_artifact("propensity_v1.joblib", MockClassifier())
        payload = {
            "modelType": "PURCHASE_PROPENSITY",
            "artifactPath": filename,
            "features": [
                {"entityId": "cust-88", "featureVector": [90.0]},
            ],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        p = data["predictions"][0]
        self.assertEqual(p["entityId"], "cust-88")
        self.assertEqual(p["predictionValue"], 0.9)

    def test_predict_anomaly_detection_success(self):
        filename = self._create_artifact("anomaly_v1.joblib", MockClassifier())
        payload = {
            "modelType": "ANOMALY_DETECTION",
            "artifactPath": filename,
            "features": [
                {"entityId": "ord-99", "featureVector": [10.0]},
            ],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        p = data["predictions"][0]
        self.assertEqual(p["entityId"], "ord-99")
        self.assertEqual(p["predictionValue"], 0.1)

    def test_predict_empty_feature_list_returns_empty_predictions(self):
        filename = self._create_artifact("empty_features.joblib", MockRegressor())
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": filename,
            "features": [],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["predictions"], [])

    def test_predict_with_relative_ml_artifacts_key(self):
        filename = self._create_artifact("demand_rel.joblib", MockRegressor())
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": f".ml_artifacts/{filename}",
            "features": [{"entityId": "prod-1", "featureVector": [10.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["predictions"][0]["entityId"], "prod-1")

    def test_predict_with_relative_artifacts_prefix_key(self):
        filename = self._create_artifact("demand_art.joblib", MockRegressor())
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": f"artifacts/{filename}",
            "features": [{"entityId": "prod-2", "featureVector": [5.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["predictions"][0]["entityId"], "prod-2")

    def test_predict_with_legacy_absolute_path_backward_compat(self):
        filename = self._create_artifact("demand_abs.joblib", MockRegressor())
        abs_path = os.path.join(self.temp_dir, filename)
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": abs_path,
            "features": [{"entityId": "prod-3", "featureVector": [2.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["predictions"][0]["entityId"], "prod-3")

    def test_predict_unsupported_model_type_returns_400(self):
        filename = self._create_artifact("model.joblib", MockRegressor())
        payload = {
            "modelType": "NONEXISTENT_MODEL_TYPE",
            "artifactPath": filename,
            "features": [{"entityId": "e1", "featureVector": [1.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertFalse(data["success"])
        self.assertIn("Unknown model type", data["error"])

    def test_predict_missing_artifact_returns_404(self):
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": "nonexistent_model_file.joblib",
            "features": [{"entityId": "e1", "featureVector": [1.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 404)
        data = response.json()
        self.assertFalse(data["success"])
        self.assertIn("Artifact not found", data["error"])

    def test_predict_path_traversal_rejected_with_400(self):
        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": "../../Windows/System32/drivers/etc/hosts",
            "features": [{"entityId": "e1", "featureVector": [1.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertFalse(data["success"])
        self.assertIn("Path traversal detected", data["error"])

    def test_predict_corrupted_artifact_returns_500(self):
        corrupt_path = os.path.join(self.temp_dir, "corrupt.joblib")
        with open(corrupt_path, "wb") as f:
            f.write(b"not a valid joblib serialized file")

        payload = {
            "modelType": "DEMAND_FORECASTING",
            "artifactPath": "corrupt.joblib",
            "features": [{"entityId": "e1", "featureVector": [1.0]}],
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 500)
        data = response.json()
        self.assertFalse(data["success"])
        self.assertIn("Failed to load artifact", data["error"])

    def test_predict_malformed_request_returns_422(self):
        # Missing modelType and artifactPath
        payload = {
            "features": "not a list",
        }
        response = self.client.post("/v1/predict", json=payload)
        self.assertEqual(response.status_code, 422)
        data = response.json()
        self.assertFalse(data["success"])
        self.assertIn("Validation failed", data["error"])


if __name__ == "__main__":
    unittest.main()
