# apps/ml-service/app/main.py
"""
FastAPI Application Entry Point for Standalone ML Inference Service.
"""
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import settings

app = FastAPI(
    title="Commerce ML Inference Service",
    description="Stateless high-throughput microservice for predictive commerce ML scoring.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError):
    """
    Translates Pydantic validation errors into consistent machine-readable error responses.
    """
    first_error = exc.errors()[0] if exc.errors() else {}
    loc = " -> ".join(str(l) for l in first_error.get("loc", []))
    msg = first_error.get("msg", "Invalid request body")
    error_summary = f"Validation failed at '{loc}': {msg}" if loc else msg

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "success": False,
            "error": error_summary,
        },
    )


# Register API routes
app.include_router(router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
