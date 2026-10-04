# ml/data/bootstrap.py
"""
Cold-start bootstrap dataset generator for predictive ML models.
All generated datasets are explicitly marked as synthetic and NEVER contaminate transactional truth.
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List
import numpy as np


def generate_bootstrap_demand(
    tenant_id: str,
    product_ids: List[str] = None,
    days: int = 45,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """
    Generate synthetic daily demand history for cold start.
    Simulates base demand + trend + weekly seasonality + noise.
    """
    rng = np.random.RandomState(seed)
    if not product_ids:
        product_ids = [f"prod-bootstrap-{i}" for i in range(1, 6)]

    records: List[Dict[str, Any]] = []
    base_date = datetime.now() - timedelta(days=days)

    for prod_idx, prod_id in enumerate(product_ids):
        base_demand = 5.0 + (prod_idx * 3.0)
        price = 100.0 + (prod_idx * 50.0)

        for day in range(days):
            current_date = base_date + timedelta(days=day)
            day_of_week = current_date.weekday()
            # Weekend bump
            weekend_factor = 1.3 if day_of_week in [5, 6] else 1.0
            # Slight upward trend
            trend_factor = 1.0 + (0.005 * day)
            noise = rng.normal(0, 1.5)
            units = max(0, int(round((base_demand * weekend_factor * trend_factor) + noise)))
            order_count = max(1, int(round(units * 0.7))) if units > 0 else 0

            records.append({
                "tenantId": tenant_id,
                "productId": prod_id,
                "sku": f"sku-{prod_id}",
                "date": current_date.strftime("%Y-%m-%d"),
                "unitsSold": units,
                "orderCount": order_count,
                "price": price,
                "dataSourceType": "BOOTSTRAP",
                "isSynthetic": True,
            })

    return records


def generate_bootstrap_stockout(
    tenant_id: str,
    sku_ids: List[str] = None,
    count: int = 30,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """
    Generate synthetic inventory and sales velocity data for stockout risk classification.
    """
    rng = np.random.RandomState(seed)
    if not sku_ids:
        sku_ids = [f"sku-bootstrap-{i}" for i in range(1, count + 1)]

    records: List[Dict[str, Any]] = []
    for i, sku in enumerate(sku_ids):
        velocity_7d = float(rng.uniform(1.0, 15.0))
        velocity_14d = float(velocity_7d * rng.uniform(0.85, 1.15))
        # Mix of healthy stock, critical stock, and stockout cases
        if i % 3 == 0:
            # High risk / stockout soon
            on_hand = int(rng.uniform(1, 10))
            reserved = int(rng.uniform(0, 3))
        elif i % 3 == 1:
            # Moderate risk
            on_hand = int(rng.uniform(15, 35))
            reserved = int(rng.uniform(1, 5))
        else:
            # Low risk / ample stock
            on_hand = int(rng.uniform(60, 150))
            reserved = int(rng.uniform(2, 10))

        records.append({
            "tenantId": tenant_id,
            "sku": sku,
            "productId": f"prod-{sku}",
            "currentOnHand": on_hand,
            "reservedQuantity": reserved,
            "velocity7d": round(velocity_7d, 2),
            "velocity14d": round(velocity_14d, 2),
            "leadTimeDays": 3,
            "dataSourceType": "BOOTSTRAP",
            "isSynthetic": True,
        })

    return records


def generate_bootstrap_propensity(
    tenant_id: str,
    customer_ids: List[str] = None,
    count: int = 40,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """
    Generate synthetic customer behavioral signals for purchase propensity classification.
    """
    rng = np.random.RandomState(seed)
    if not customer_ids:
        customer_ids = [f"cust-bootstrap-{i}" for i in range(1, count + 1)]

    records: List[Dict[str, Any]] = []
    for i, cust_id in enumerate(customer_ids):
        # Mix of active loyal, lapsing, and dormant customers
        if i % 3 == 0:
            # High propensity: recent purchase, frequent
            recency = int(rng.uniform(1, 7))
            freq_30d = int(rng.uniform(3, 8))
            freq_90d = int(freq_30d + rng.uniform(2, 6))
            total_orders = freq_90d + int(rng.uniform(5, 20))
            total_spend = float(total_orders * rng.uniform(500, 2000))
        elif i % 3 == 1:
            # Medium propensity
            recency = int(rng.uniform(10, 25))
            freq_30d = int(rng.uniform(1, 2))
            freq_90d = int(freq_30d + rng.uniform(1, 4))
            total_orders = freq_90d + int(rng.uniform(2, 8))
            total_spend = float(total_orders * rng.uniform(400, 1500))
        else:
            # Low propensity: dormant
            recency = int(rng.uniform(35, 90))
            freq_30d = 0
            freq_90d = int(rng.uniform(0, 1))
            total_orders = max(1, freq_90d + int(rng.uniform(0, 3)))
            total_spend = float(total_orders * rng.uniform(300, 1000))

        records.append({
            "tenantId": tenant_id,
            "customerId": cust_id,
            "recencyDays": recency,
            "frequency30d": freq_30d,
            "frequency90d": freq_90d,
            "totalOrders": total_orders,
            "monetaryTotal": round(total_spend, 2),
            "dataSourceType": "BOOTSTRAP",
            "isSynthetic": True,
        })

    return records
