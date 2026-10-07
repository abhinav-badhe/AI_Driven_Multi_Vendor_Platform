# ml/models/anomaly_detector.py
"""
Order Anomaly Detector model training, evaluation, and inference.
Flags orders with unusual value / quantity / timing patterns for manual review.
Uses LogisticRegression and RandomForestClassifier.
Outputs probability that an order is anomalous.
"""
from typing import Any, Dict, List, Tuple
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split


class AnomalyDetector:
    def __init__(self, algorithm: str = "RandomForestClassifier", seed: int = 42, **kwargs):
        self.algorithm = algorithm
        self.seed = seed
        self.hyperparameters = kwargs
        self.feature_names: List[str] = []
        if algorithm == "LogisticRegression":
            c_val = kwargs.get("C", 1.0)
            self.model = LogisticRegression(C=c_val, random_state=seed, max_iter=500)
        else:
            n_estimators = kwargs.get("n_estimators", 50)
            max_depth = kwargs.get("max_depth", 6)
            self.model = RandomForestClassifier(
                n_estimators=n_estimators,
                max_depth=max_depth,
                random_state=seed,
            )

    def train_and_evaluate(
        self,
        X: np.ndarray,
        y: np.ndarray,
        feature_names: List[str],
        test_size: float = 0.2,
        val_size: float = 0.15,
    ) -> Tuple[Dict[str, float], Dict[str, float], Dict[str, float]]:
        self.feature_names = feature_names

        # Check if single class
        unique_classes = np.unique(y)
        stratify = y if len(unique_classes) > 1 and np.min(np.bincount(y.astype(int))) >= 2 else None

        X_train_val, X_test, y_train_val, y_test = train_test_split(
            X, y, test_size=test_size, random_state=self.seed, stratify=stratify
        )

        stratify_val = y_train_val if len(np.unique(y_train_val)) > 1 and np.min(np.bincount(y_train_val.astype(int))) >= 2 else None
        val_ratio = val_size / (1.0 - test_size)
        X_train, X_val, y_train, y_val = train_test_split(
            X_train_val, y_train_val, test_size=val_ratio, random_state=self.seed, stratify=stratify_val
        )

        self.model.fit(X_train, y_train)

        def eval_split(X_sub, y_sub):
            preds = self.model.predict(X_sub)
            probas = None
            try:
                probas = self.model.predict_proba(X_sub)[:, 1]
            except Exception:
                probas = None
            metrics = {
                "accuracy": float(accuracy_score(y_sub, preds)),
                "f1": float(f1_score(y_sub, preds, zero_division=0)),
                "precision": float(precision_score(y_sub, preds, zero_division=0)),
                "recall": float(recall_score(y_sub, preds, zero_division=0)),
            }
            if probas is not None and len(np.unique(y_sub)) > 1:
                try:
                    metrics["roc_auc"] = float(roc_auc_score(y_sub, probas))
                except Exception:
                    pass
            return metrics

        train_metrics = eval_split(X_train, y_train)
        val_metrics = eval_split(X_val, y_val)
        test_metrics = eval_split(X_test, y_test)

        return train_metrics, val_metrics, test_metrics

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.model.predict_proba(X)
