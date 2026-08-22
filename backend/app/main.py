"""FastAPI application: wiring, startup seeding, JSON error shape."""

from __future__ import annotations

import os
from pathlib import Path

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.db import SessionLocal, init_db
from app.routers import chat, invoices
from app.schemas import HealthResponse
from app.seed import count_invoices, seed

logger = logging.getLogger("app")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


def _startup_seed() -> None:
    """Create the table and, if it is empty, fill it. A seed failure must not stop the server."""
    init_db()
    settings = get_settings()
    try:
        with SessionLocal() as session:
            existing = count_invoices(session)
            if existing:
                logger.info("Startup: %s invoices already present, skipping seed", existing)
                return
            report = seed(session, settings)
            logger.info("Startup seed: %s", report.summary())
    except Exception:
        logger.exception("Startup seed failed; the API will run against whatever rows exist")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info(
        "Starting on %s database, Claude %s",
        settings.database_kind,
        "configured" if settings.llm_configured else "not configured (LLM endpoints return 503)",
    )
    _startup_seed()
    yield


app = FastAPI(
    title="lang-chain-app",
    description="Invoice extraction and natural-language querying with LangChain and Claude.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    # Local demo: any localhost port may talk to the API (Vite picks a free port).
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Every error leaves the API as {"error": "..."}."""
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    problems = "; ".join(
        f"{'.'.join(str(part) for part in err['loc'][1:])}: {err['msg']}" for err in exc.errors()
    )
    return JSONResponse(status_code=422, content={"error": f"Invalid request - {problems}"})


@app.get("/health", response_model=HealthResponse, tags=["meta"])
def health() -> HealthResponse:
    """What the frontend uses to decide whether the LLM features are available."""
    settings = get_settings()
    return HealthResponse(
        ok=True,
        database=settings.database_kind,
        llm_configured=settings.llm_configured,
        model=settings.anthropic_model,
    )


app.include_router(invoices.router)
app.include_router(chat.router)


# Production: the built React app is served from the same origin (see Dockerfile), so one URL does both.
STATIC_DIR = Path(os.environ.get("STATIC_DIR") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="frontend")
