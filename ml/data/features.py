# ml/data/features.py
"""
Feature engineering and target definition for predictive commerce models.
Ensures reproducible features, chronological integrity, and zero future data leakage.
"""
from datetime import datetime
from typing import Any, Dict, List, Tuple
import numpy as np
import pandas as pd


def prepare_demand_features(
    records: List[Dict[str, Any]],
    horizon_days: int = 7,
) -> Tuple[np.ndarray, np.ndarray, List[str], List[Dict[str, Any]]]:
    """
    Extract features and cumulative horizon target for Demand Forecasting.
    Features:
      - lag_1_demand
      - lag_7_demand
      - rolling_mean_7d
      - rolling_mean_14d
      - rolling_std_7d
      - unit_price
      - day_of_week
      - is_weekend
    Target:
      - cumulative units sold over the next `horizon_days`.
    """
    df = pd.DataFrame(records)
    if df.empty or "date" not in df.columns:
        return np.empty((0, 8)), np.empty((0,)), [], []

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"])
    df = df.sort_values(by=["productId", "date"]).reset_index(drop=True)

    feature_names = [
        "lag_1_demand",
        "lag_7_demand",
        "rolling_mean_7d",
        "rolling_mean_14d",
        "rolling_std_7d",
        "unit_price",
        "day_of_week",
        "is_weekend",
    ]

    all_X = []
    all_y = []
    metadata = []

    for product_id, group in df.groupby("productId"):
        group = group.sort_values("date").reset_index(drop=True)
        n = len(group)
        if n < 15:  # Need minimum historical window for rolling and lag
            continue

        units = group["unitsSold"].values.astype(float)
        prices = group.get("price", pd.Series(np.zeros(n))).values.astype(float)
        dates = group["date"].values

        for i in range(14, n - horizon_days):
            lag_1 = units[i]
            lag_7 = units[i - 6] if i >= 6 else units[0]
            roll_7 = float(np.mean(units[max(0, i - 6): i + 1]))
            roll_14 = float(np.mean(units[max(0, i - 13): i + 1]))
            roll_std_7 = float(np.std(units[max(0, i - 6): i + 1]))
            price = prices[i] if prices[i] > 0 else 100.0

            dt = pd.to_datetime(dates[i])
            dow = float(dt.weekday())
            is_weekend = 1.0 if dow in [5, 6] else 0.0

            # Target: sum of units in future horizon window (strictly future, no leakage)
            target = float(np.sum(units[i + 1: i + 1 + horizon_days]))

            all_X.append([lag_1, lag_7, roll_7, roll_14, roll_std_7, price, dow, is_weekend])
            all_y.append(target)
            metadata.append({
                "productId": product_id,
                "sku": group.get("sku", pd.Series([""] * n)).iloc[i],
                "date": dt.strftime("%Y-%m-%d"),
            })

    if not all_X:
        return np.empty((0, len(feature_names))), np.empty((0,)), feature_names, []

    return np.array(all_X), np.array(all_y), feature_names, metadata


def prepare_stockout_features(
    records: List[Dict[str, Any]],
    horizon_days: int = 7,
) -> Tuple[np.ndarray, np.ndarray, List[str], List[Dict[str, Any]]]:
    """
    Extract features and binary target for Stockout Risk Prediction.
    Features:
      - current_on_hand
      - reserved_quantity
      - velocity_7d
      - velocity_14d
      - days_of_supply
      - runout_rate
      - lead_time_days
    Target:
      - 1 if expected stockout within horizon, 0 otherwise.
    """
    feature_names = [
        "current_on_hand",
        "reserved_quantity",
        "velocity_7d",
        "velocity_14d",
        "days_of_supply",
        "runout_rate",
        "lead_time_days",
    ]

    all_X = []
    all_y = []
    metadata = []

    for rec in records:
        on_hand = float(rec.get("currentOnHand", 0))
        reserved = float(rec.get("reservedQuantity", 0))
        v7 = float(rec.get("velocity7d", 0))
        v14 = float(rec.get("velocity14d", v7))
        lead_time = float(rec.get("leadTimeDays", 3))

        available = max(0.0, on_hand - reserved)
        daily_rate = max(0.1, v7 / 7.0 if v7 > 0 else 0.1)
        days_of_supply = available / daily_rate
        expected_demand = daily_rate * horizon_days
        runout_rate = expected_demand / max(1.0, available)

        # Ground truth target: if available is less than expected demand during horizon
        target = 1.0 if available <= expected_demand else 0.0

        all_X.append([on_hand, reserved, v7, v14, days_of_supply, runout_rate, lead_time])
        all_y.append(target)
        metadata.append({
            "sku": rec.get("sku", ""),
            "productId": rec.get("productId", ""),
        })

    if not all_X:
        return np.empty((0, len(feature_names))), np.empty((0,)), feature_names, []

    return np.array(all_X), np.array(all_y), feature_names, metadata


def prepare_anomaly_features(
    records: List[Dict[str, Any]],
    horizon_days: int = 7,
) -> Tuple[np.ndarray, np.ndarray, List[str], List[Dict[str, Any]]]:
    """
    Extract features and heuristic target for Order Anomaly Detection.
    Features:
      - log_total_amount
      - line_count
      - total_quantity
      - avg_unit_price
      - hour_of_day
      - is_night_order
    Target (heuristic ground truth, same style as the other classifiers):
      - 1 if the order is an extreme outlier on value, bulk size, or timing.
    """
    feature_names = [
        "log_total_amount",
        "line_count",
        "total_quantity",
        "avg_unit_price",
        "hour_of_day",
        "is_night_order",
    ]

    all_X = []
    all_y = []
    metadata = []

    for rec in records:
        total = max(1.0, float(rec.get("totalAmount", 100)))
        line_count = float(rec.get("lineCount", 1))
        total_qty = max(1.0, float(rec.get("totalQuantity", 1)))
        hour = float(rec.get("hourOfDay", 12))
        avg_unit = total / total_qty
        is_night = 1.0 if (hour < 6 or hour >= 23) else 0.0

        # Heuristic label: extreme value, bulk quantity, or odd-hour bulk buy
        anomaly_score = 0.0
        if total >= 20000:
            anomaly_score += 0.5
        if total_qty >= 40:
            anomaly_score += 0.3
        if is_night and total_qty >= 10:
            anomaly_score += 0.3
        if avg_unit >= 15000:
            anomaly_score += 0.2
        target = 1.0 if anomaly_score >= 0.5 else 0.0

        all_X.append([np.log(total), line_count, total_qty, avg_unit, hour, is_night])
        all_y.append(target)
        metadata.append({
            "orderId": rec.get("orderId", ""),
        })

    if not all_X:
        return np.empty((0, len(feature_names))), np.empty((0,)), feature_names, []

    return np.array(all_X), np.array(all_y), feature_names, metadata


def prepare_propensity_features(
    records: List[Dict[str, Any]],
    horizon_days: int = 14,
) -> Tuple[np.ndarray, np.ndarray, List[str], List[Dict[str, Any]]]:
    """
    Extract features and binary target for Customer Purchase Propensity.
    Features:
      - recency_days
      - frequency_30d
      - frequency_90d
      - total_orders
      - monetary_total
      - avg_order_value
    Target:
      - 1 if high likelihood / repeat purchase in horizon, 0 otherwise.
    """
    feature_names = [
        "recency_days",
        "frequency_30d",
        "frequency_90d",
        "total_orders",
        "monetary_total",
        "avg_order_value",
    ]

    all_X = []
    all_y = []
    metadata = []

    for rec in records:
        recency = float(rec.get("recencyDays", 30))
        f30 = float(rec.get("frequency30d", 0))
        f90 = float(rec.get("frequency90d", f30))
        tot_orders = max(1.0, float(rec.get("totalOrders", 1)))
        tot_spend = float(rec.get("monetaryTotal", 500))
        aov = tot_spend / tot_orders

        # Ground truth label logic: recency <= 14 or high 30-day frequency
        # Indicates propensity to transact in next window
        propensity_score = (max(0.0, 30.0 - recency) / 30.0) * 0.6 + (min(5.0, f30) / 5.0) * 0.4
        target = 1.0 if propensity_score >= 0.45 else 0.0

        all_X.append([recency, f30, f90, tot_orders, tot_spend, aov])
        all_y.append(target)
        metadata.append({
            "customerId": rec.get("customerId", ""),
        })

    if not all_X:
        return np.empty((0, len(feature_names))), np.empty((0,)), feature_names, []

    return np.array(all_X), np.array(all_y), feature_names, metadata
