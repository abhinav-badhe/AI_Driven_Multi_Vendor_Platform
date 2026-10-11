# ml/tests/test_inference_engine.py
"""
Focused unit tests for the reusable ML Inference Engine.
Tests all model types, contract invariants, probability handling, confidence calculations,
and error semantics using deterministic synthetic mock estimators (zero production disk artifacts).
"""
import os
import tempfile
import unittest

import joblib
import numpy as np

from ml.inference.engine import (
    InferenceEngine,
    SUPPORTED_MODEL_TYPES,
    generate_predictions,
    load_model_artifact,
    resolve_artifact_path,
)


class MockRegressor:
    def predict(self, X):
        # Returns simple linear function of first column
        return np.array([float(row[0]) * 2.0 for row in X])


class MockBinaryClassifier:
    def predict_proba(self, X):
        # Returns binary probabilities [P(0), P(1)]
        results = []
        for row in X:
            p1 = min(1.0, max(0.0, float(row[0]) / 100.0))
            results.append([1.0 - p1, p1])
        return np.array(results)


class MockSingleOutputClassifier:
    def predict_proba(self, X):
        # Single column probability fallback
        return np.array([[0.75] for _ in X])


class TestInferenceEngine(unittest.TestCase):
    def setUp(self):
        self.engine = InferenceEngine()
        self.temp_files = []

    def tearDown(self):
        for path in self.temp_files:
            if os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def _create_temp_artifact(self, model):
        fd, path = tempfile.mkstemp(suffix=".joblib")
        os.close(fd)
        self.temp_files.append(path)
        joblib.dump({"model": model, "model_type": "TEST"}, path)
        return path

    def test_supported_model_types(self):
        expected = {
            "DEMAND_FORECASTING",
            "STOCKOUT_RISK",
            "PURCHASE_PROPENSITY",
            "ANOMALY_DETECTION",
        }
        self.assertEqual(SUPPORTED_MODEL_TYPES, expected)

    def test_missing_artifact_path_returns_error(self):
        result = self.engine.predict({
            "artifactPath": "/nonexistent/path/to/missing_model.joblib",
            "modelType": "DEMAND_FORECASTING",
            "features": [{"entityId": "e1", "featureVector": [1.0, 2.0]}],
        })
        self.assertFalse(result["success"])
        self.assertIn("Artifact not found", result["error"])

    def test_unsupported_model_type_returns_error(self):
        path = self._create_temp_artifact(MockRegressor())
        result = self.engine.predict({
            "artifactPath": path,
            "modelType": "UNSUPPORTED_TYPE_XYZ",
            "features": [{"entityId": "e1", "featureVector": [1.0, 2.0]}],
        })
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "Unknown model type: UNSUPPORTED_TYPE_XYZ")

    def test_empty_features_returns_empty_predictions(self):
        path = self._create_temp_artifact(MockRegressor())
        result = self.engine.predict({
            "artifactPath": path,
            "modelType": "DEMAND_FORECASTING",
            "features": [],
        })
        self.assertTrue(result["success"])
        self.assertEqual(result["predictions"], [])

    def test_demand_forecasting_prediction_semantics(self):
        path = self._create_temp_artifact(MockRegressor())
        payload = {
            "artifactPath": path,
            "modelType": "DEMAND_FORECASTING",
            "features": [
                {"entityId": "prod-1", "featureVector": [10.0, 5.0, 1.0, 0.0]},
                {"entityId": "prod-2", "featureVector": [25.5, 3.0, 0.0, 1.0]},
            ],
        }
        result = self.engine.predict(payload)
        self.assertTrue(result["success"])
        predictions = result["predictions"]
        self.assertEqual(len(predictions), 2)

        # First entity: 10.0 * 2.0 = 20.0
        self.assertEqual(predictions[0]["entityId"], "prod-1")
        self.assertEqual(predictions[0]["predictionValue"], 20.0)
        self.assertIsNone(predictions[0]["probability"])
        self.assertEqual(predictions[0]["confidence"], 0.85)

        # Second entity: 25.5 * 2.0 = 51.0
        self.assertEqual(predictions[1]["entityId"], "prod-2")
        self.assertEqual(predictions[1]["predictionValue"], 51.0)
        self.assertIsNone(predictions[1]["probability"])
        self.assertEqual(predictions[1]["confidence"], 0.85)

    def test_stockout_risk_classification_semantics(self):
        path = self._create_temp_artifact(MockBinaryClassifier())
        payload = {
            "artifactPath": path,
            "modelType": "STOCKOUT_RISK",
            "features": [
                {"entityId": "sku-1", "featureVector": [80.0, 1.0]},  # p1 = 0.80
                {"entityId": "sku-2", "featureVector": [20.0, 0.0]},  # p1 = 0.20
            ],
        }
        result = self.engine.predict(payload)
        self.assertTrue(result["success"])
        preds = result["predictions"]

        # sku-1: p = 0.80 -> confidence = |0.80 - 0.5| * 2.0 = 0.60
        self.assertEqual(preds[0]["entityId"], "sku-1")
        self.assertEqual(preds[0]["predictionValue"], 0.8)
        self.assertEqual(preds[0]["probability"], 0.8)
        self.assertEqual(preds[0]["confidence"], 0.6)

        # sku-2: p = 0.20 -> confidence = |0.20 - 0.5| * 2.0 = 0.60
        self.assertEqual(preds[1]["entityId"], "sku-2")
        self.assertEqual(preds[1]["predictionValue"], 0.2)
        self.assertEqual(preds[1]["probability"], 0.2)
        self.assertEqual(preds[1]["confidence"], 0.6)

    def test_purchase_propensity_classification_semantics(self):
        path = self._create_temp_artifact(MockBinaryClassifier())
        payload = {
            "artifactPath": path,
            "modelType": "PURCHASE_PROPENSITY",
            "features": [
                {"entityId": "cust-1", "featureVector": [95.0]},  # p1 = 0.95
            ],
        }
        result = self.engine.predict(payload)
        self.assertTrue(result["success"])
        preds = result["predictions"]

        # cust-1: p = 0.95 -> confidence = |0.95 - 0.5| * 2.0 = 0.90
        self.assertEqual(preds[0]["entityId"], "cust-1")
        self.assertEqual(preds[0]["predictionValue"], 0.95)
        self.assertEqual(preds[0]["probability"], 0.95)
        self.assertEqual(preds[0]["confidence"], 0.9)

    def test_anomaly_detection_classification_semantics(self):
        path = self._create_temp_artifact(MockBinaryClassifier())
        payload = {
            "artifactPath": path,
            "modelType": "ANOMALY_DETECTION",
            "features": [
                {"entityId": "ord-1", "featureVector": [50.0]},  # p1 = 0.50 -> confidence 0.0
            ],
        }
        result = self.engine.predict(payload)
        self.assertTrue(result["success"])
        preds = result["predictions"]

        self.assertEqual(preds[0]["entityId"], "ord-1")
        self.assertEqual(preds[0]["predictionValue"], 0.5)
        self.assertEqual(preds[0]["probability"], 0.5)
        self.assertEqual(preds[0]["confidence"], 0.0)

    def test_single_column_probability_fallback(self):
        path = self._create_temp_artifact(MockSingleOutputClassifier())
        payload = {
            "artifactPath": path,
            "modelType": "STOCKOUT_RISK",
            "features": [
                {"entityId": "sku-fallback", "featureVector": [1.0]},
            ],
        }
        result = self.engine.predict(payload)
        self.assertTrue(result["success"])
        self.assertEqual(result["predictions"][0]["predictionValue"], 0.75)
        self.assertEqual(result["predictions"][0]["probability"], 0.75)
        self.assertEqual(result["predictions"][0]["confidence"], 0.5)

    def test_corrupted_artifact_error_handling(self):
        fd, path = tempfile.mkstemp(suffix=".joblib")
        os.write(fd, b"corrupted bytes not a valid joblib file")
        os.close(fd)
        self.temp_files.append(path)

        result = self.engine.predict({
            "artifactPath": path,
            "modelType": "DEMAND_FORECASTING",
            "features": [{"entityId": "e1", "featureVector": [1.0]}],
        })
        self.assertFalse(result["success"])
        self.assertIn("Failed to load artifact", result["error"])

    def test_module_level_generate_predictions_delegation(self):
        path = self._create_temp_artifact(MockRegressor())
        payload = {
            "artifactPath": path,
            "modelType": "DEMAND_FORECASTING",
            "features": [{"entityId": "p-top", "featureVector": [7.0]}],
        }
        result = generate_predictions(payload)
        self.assertTrue(result["success"])
        self.assertEqual(result["predictions"][0]["entityId"], "p-top")
        self.assertEqual(result["predictions"][0]["predictionValue"], 14.0)

    def test_resolve_artifact_path_direct_absolute(self):
        path = self._create_temp_artifact(MockRegressor())
        resolved = resolve_artifact_path(path)
        self.assertIsNotNone(resolved)
        self.assertEqual(os.path.realpath(resolved), os.path.realpath(path))

    def test_resolve_artifact_path_relative_and_bare(self):
        # Create artifact in temp dir and test resolution using base_dir
        with tempfile.TemporaryDirectory() as tmp_root:
            art_dir = os.path.join(tmp_root, ".ml_artifacts")
            os.makedirs(art_dir, exist_ok=True)
            art_path = os.path.join(art_dir, "tenant-test_DEMAND_FORECASTING_v1.joblib")
            joblib.dump({"model": MockRegressor()}, art_path)

            # 1. Relative key starting with .ml_artifacts/
            rel_key = ".ml_artifacts/tenant-test_DEMAND_FORECASTING_v1.joblib"
            resolved = resolve_artifact_path(rel_key, base_dir=tmp_root)
            self.assertIsNotNone(resolved)
            self.assertEqual(os.path.realpath(resolved), os.path.realpath(art_path))

            # 2. Bare filename
            bare_name = "tenant-test_DEMAND_FORECASTING_v1.joblib"
            resolved_bare = resolve_artifact_path(bare_name, base_dir=tmp_root)
            self.assertIsNotNone(resolved_bare)
            self.assertEqual(os.path.realpath(resolved_bare), os.path.realpath(art_path))

            # 3. Relative key starting with artifacts/
            art_prefix_key = "artifacts/tenant-test_DEMAND_FORECASTING_v1.joblib"
            resolved_art = resolve_artifact_path(art_prefix_key, base_dir=tmp_root)
            self.assertIsNotNone(resolved_art)
            self.assertEqual(os.path.realpath(resolved_art), os.path.realpath(art_path))

    def test_resolve_artifact_path_nonexistent_returns_none(self):
        self.assertIsNone(resolve_artifact_path(""))
        self.assertIsNone(resolve_artifact_path("nonexistent_model_xyz.joblib"))


if __name__ == "__main__":
    unittest.main()
