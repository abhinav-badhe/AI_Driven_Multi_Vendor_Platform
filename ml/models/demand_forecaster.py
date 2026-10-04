# ml/models/demand_forecaster.py
"""
Demand Forecaster model training, evaluation, and inference.
Uses RandomForestRegressor and Ridge regression with deterministic seeds.
"""
from typing import Any, Dict, List, Tuple
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split


class DemandForecaster:
    def __init__(self, algorithm: str = "RandomForestRegressor", seed: int = 42, **kwargs):
        self.algorithm = algorithm
        self.seed = seed
        self.hyperparameters = kwargs
        self.feature_names: List[str] = []
        if algorithm == "Ridge":
            alpha = kwargs.get("alpha", 1.0)
            self.model = Ridge(alpha=alpha, random_state=seed)
        else:
            n_estimators = kwargs.get("n_estimators", 50)
            max_depth = kwargs.get("max_depth", 8)
            self.model = RandomForestRegressor(
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
        """
        Train with train/val/test split and return evaluation metrics.
        """
        self.feature_names = feature_names

        # Train/Test split
        X_train_val, X_test, y_train_val, y_test = train_test_split(
            X, y, test_size=test_size, random_state=self.seed, shuffle=False
        )

        val_ratio = val_size / (1.0 - test_size)
        X_train, X_val, y_train, y_val = train_test_split(
            X_train_val, y_train_val, test_size=val_ratio, random_state=self.seed, shuffle=False
        )

        # Fit model
        self.model.fit(X_train, y_train)

        # Train metrics
        y_train_pred = self.model.predict(X_train)
        train_metrics = {
            "mae": float(mean_absolute_error(y_train, y_train_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_train, y_train_pred))),
            "r2": float(r2_score(y_train, y_train_pred)),
        }

        # Validation metrics
        y_val_pred = self.model.predict(X_val)
        val_metrics = {
            "mae": float(mean_absolute_error(y_val, y_val_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_val, y_val_pred))),
            "r2": float(r2_score(y_val, y_val_pred)),
        }

        # Test metrics
        y_test_pred = self.model.predict(X_test)
        test_metrics = {
            "mae": float(mean_absolute_error(y_test, y_test_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_test, y_test_pred))),
            "r2": float(r2_score(y_test, y_test_pred)),
        }

        return train_metrics, val_metrics, test_metrics

    def predict(self, X: np.ndarray) -> np.ndarray:
        preds = self.model.predict(X)
        return np.maximum(0.0, preds)  # Demand cannot be negative
