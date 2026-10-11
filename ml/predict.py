# ml/predict.py
"""
Asynchronous Model Inference / Prediction Generation Entry Point.
Delegates inference logic to ml.inference.engine while preserving CLI arguments and JSON IPC.
"""
import argparse
import json
import os
import sys

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ml.inference.engine import generate_predictions


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
