# ml/tests/test_predict_cli.py
"""
CLI compatibility tests for ml/predict.py.
Verifies that the CLI entry point correctly delegates to ml.inference.engine,
supports --input-file and --output-file flags, and preserves the exact existing IPC contract.
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import joblib
import numpy as np

import ml.predict as predict_cli
from ml.inference.engine import generate_predictions


class MockPredictor:
    def predict(self, X):
        return np.array([42.5 for _ in X])


class TestPredictCliCompatibility(unittest.TestCase):
    def setUp(self):
        self.temp_files = []

    def tearDown(self):
        for path in self.temp_files:
            if os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def _create_temp_artifact(self):
        fd, path = tempfile.mkstemp(suffix=".joblib")
        os.close(fd)
        self.temp_files.append(path)
        joblib.dump({"model": MockPredictor(), "model_type": "DEMAND_FORECASTING"}, path)
        return path

    def _create_temp_json(self, data):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        self.temp_files.append(path)
        return path

    def test_cli_delegates_to_inference_engine(self):
        # Verify function identity
        self.assertIs(predict_cli.generate_predictions, generate_predictions)

    def test_cli_file_arguments_execution(self):
        artifact_path = self._create_temp_artifact()
        input_data = {
            "artifactPath": artifact_path,
            "modelType": "DEMAND_FORECASTING",
            "features": [{"entityId": "p-cli-1", "featureVector": [1.0, 2.0]}],
        }
        input_file = self._create_temp_json(input_data)

        output_fd, output_file = tempfile.mkstemp(suffix=".json")
        os.close(output_fd)
        self.temp_files.append(output_file)

        # Call predict.py main() with --input-file and --output-file
        test_args = ["predict.py", "--input-file", input_file, "--output-file", output_file]
        with patch("sys.argv", test_args):
            predict_cli.main()

        # Verify output file content
        self.assertTrue(os.path.exists(output_file))
        with open(output_file, "r", encoding="utf-8") as f:
            result = json.load(f)

        self.assertTrue(result["success"])
        self.assertEqual(len(result["predictions"]), 1)
        self.assertEqual(result["predictions"][0]["entityId"], "p-cli-1")
        self.assertEqual(result["predictions"][0]["predictionValue"], 42.5)

    def test_cli_missing_artifact_error_output(self):
        input_data = {
            "artifactPath": "/missing/model.joblib",
            "modelType": "DEMAND_FORECASTING",
            "features": [{"entityId": "p-err", "featureVector": [1.0]}],
        }
        input_file = self._create_temp_json(input_data)

        output_fd, output_file = tempfile.mkstemp(suffix=".json")
        os.close(output_fd)
        self.temp_files.append(output_file)

        test_args = ["predict.py", "--input-file", input_file, "--output-file", output_file]
        with patch("sys.argv", test_args):
            predict_cli.main()

        with open(output_file, "r", encoding="utf-8") as f:
            result = json.load(f)

        self.assertFalse(result["success"])
        self.assertIn("Artifact not found", result["error"])


if __name__ == "__main__":
    unittest.main()
