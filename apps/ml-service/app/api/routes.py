# apps/ml-service/app/api/routes.py
"""
HTTP API routes for the Standalone ML Inference Service.
Exposes /health, /ready, and /v1/predict, delegating scoring directly to ml.inference.engine.
"""
import os
import sys
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import REPO_ROOT, settings, resolve_safe_artifact_path

# Ensure repository root is on sys.path to import ml.inference.engine without duplicating code
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from ml.inference.engine import generate_predictions, SUPPORTED_MODEL_TYPES

router = APIRouter()


class FeatureItem(BaseModel):
    entityId: str = Field(..., min_length=1, description="Entity identifier (product, SKU, customer, or order)")
    featureVector: List[float] = Field(..., description="Dense numerical feature vector")


class PredictRequest(BaseModel):
    modelType: str = Field(..., min_length=1, description="Model type selector")
    artifactPath: str = Field(..., min_length=1, description="Path or relative name of model artifact")
    features: List[FeatureItem] = Field(default_factory=list, description="List of entity feature vectors to score")


class PredictionItem(BaseModel):
    entityId: str
    predictionValue: float
    probability: Optional[float] = None
    confidence: Optional[float] = None


class PredictResponse(BaseModel):
    success: bool = True
    predictions: List[PredictionItem] = Field(default_factory=list)


class ErrorResponse(BaseModel):
    success: bool = False
    error: str


@router.get("/health", tags=["Health"], summary="Liveness Probe")
async def health_check() -> Dict[str, str]:
    """
    Process liveness check. Confirms the inference service process is alive and responsive.
    """
    return {
        "status": "healthy",
        "service": settings.service_name,
    }


@router.get("/ready", tags=["Health"], summary="Readiness Probe")
async def readiness_check() -> Dict[str, Any]:
    """
    Service readiness check. Confirms ML engine dependencies (NumPy, Scikit-learn, Joblib)
    are loaded and the artifact root directory is accessible.
    """
    try:
        import joblib
        import numpy
        import sklearn
        from ml.inference.engine import InferenceEngine
        assert InferenceEngine is not None
        artifact_root_accessible = os.path.exists(settings.artifact_root)
    except Exception as exc:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "status": "not_ready",
                "error": str(exc),
            },
        )

    return {
        "status": "ready",
        "service": settings.service_name,
        "artifactRootAccessible": artifact_root_accessible,
    }


@router.post(
    "/v1/predict",
    response_model=PredictResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Bad Request / Unsupported Model Type / Path Traversal"},
        404: {"model": ErrorResponse, "description": "Artifact Not Found"},
        422: {"model": ErrorResponse, "description": "Validation Error"},
        500: {"model": ErrorResponse, "description": "Inference / Deserialization Failure"},
    },
    tags=["Inference"],
    summary="Execute Batch Model Inference",
)
async def predict_endpoint(request: PredictRequest):
    """
    Executes batch inference against a designated model artifact using the shared InferenceEngine.
    Preserves exact existing response semantics (DEMAND_FORECASTING, STOCKOUT_RISK,
    PURCHASE_PROPENSITY, ANOMALY_DETECTION).
    """
    # 1. Model Type Validation
    if request.modelType not in SUPPORTED_MODEL_TYPES:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "success": False,
                "error": f"Unknown model type: {request.modelType}",
            },
        )

    # 2. Path Traversal & Security Validation
    try:
        safe_path = resolve_safe_artifact_path(request.artifactPath, settings.artifact_root)
    except ValueError as val_err:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "success": False,
                "error": str(val_err),
            },
        )

    # 3. Missing Artifact Check
    if not os.path.exists(safe_path):
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "success": False,
                "error": f"Artifact not found: {request.artifactPath}",
            },
        )

    # 4. Delegate to Reusable ML Inference Engine
    payload = {
        "modelType": request.modelType,
        "artifactPath": safe_path,
        "features": [item.model_dump() for item in request.features],
    }

    result = generate_predictions(payload)

    # 5. Translate Engine Results to Machine-Readable HTTP Contract
    if not result.get("success"):
        err_msg = result.get("error", "Inference execution failed")
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
        if "Artifact not found" in err_msg:
            status_code = status.HTTP_404_NOT_FOUND
        elif "Unknown model type" in err_msg:
            status_code = status.HTTP_400_BAD_REQUEST

        return JSONResponse(
            status_code=status_code,
            content={
                "success": False,
                "error": err_msg,
            },
        )

    return PredictResponse(
        success=True,
        predictions=result.get("predictions", []),
    )
