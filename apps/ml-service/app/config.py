# apps/ml-service/app/config.py
"""
Configuration and security path resolution for Standalone ML Inference Service.
"""
import os
from pydantic import BaseModel

# Repository root calculation: apps/ml-service/app -> apps/ml-service -> apps -> repo_root
REPO_ROOT = os.path.abspath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "..",
        "..",
    )
)


class Settings(BaseModel):
    service_name: str = "ml-inference-service"
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))
    artifact_root: str = os.getenv(
        "ML_ARTIFACT_ROOT",
        os.path.join(REPO_ROOT, ".ml_artifacts"),
    )


settings = Settings()


def resolve_safe_artifact_path(artifact_path: str, artifact_root: str = None) -> str:
    """
    Resolves an artifact path strictly within the configured artifact root directory.
    Prevents directory traversal attacks (e.g. '../../etc/passwd').

    Accepts:
      - Bare filenames: 'tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib'
      - Relative paths: '.ml_artifacts/tenant-alpha_DEMAND_FORECASTING_v1.0.0.joblib'
      - Absolute paths: must point strictly inside the configured artifact root.

    Raises:
      ValueError: If the resolved path escapes the configured artifact root.
      ValueError: If artifact_path is empty or invalid.
    """
    if not artifact_path or not isinstance(artifact_path, str) or not artifact_path.strip():
        raise ValueError("Invalid artifact path: path cannot be empty")

    root = os.path.realpath(os.path.abspath(artifact_root or settings.artifact_root))

    # Clean and normalize input path
    cleaned = artifact_path.strip()

    if os.path.isabs(cleaned):
        candidate = os.path.realpath(os.path.abspath(cleaned))
    else:
        # If relative path starts with .ml_artifacts or artifacts, strip the prefix to avoid double-nesting
        norm = os.path.normpath(cleaned)
        parts = norm.split(os.sep)
        if parts and parts[0] in [".ml_artifacts", "artifacts"]:
            norm = os.sep.join(parts[1:])
        candidate = os.path.realpath(os.path.abspath(os.path.join(root, norm)))

    # Ensure candidate path is strictly inside root
    try:
        common = os.path.commonpath([root, candidate])
    except ValueError:
        # On Windows, different drives (e.g. C: vs D:) raise ValueError in commonpath
        raise ValueError(
            f"Path traversal detected: artifact path '{artifact_path}' is outside artifact root"
        )

    if common != root or candidate == root:
        raise ValueError(
            f"Path traversal detected: artifact path '{artifact_path}' escapes artifact root"
        )

    return candidate
