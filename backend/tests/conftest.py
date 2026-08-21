"""Test wiring: a throwaway SQLite file, no API key, no network."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

# Set before any app import: config.get_settings() is cached and db.py builds the engine at import.
_TMP_DIR = Path(tempfile.mkdtemp(prefix="lang-chain-app-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP_DIR / 'test.db').as_posix()}"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["ANTHROPIC_MODEL"] = "claude-sonnet-5"
os.environ["CORS_ORIGINS"] = "http://localhost:5173"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import Engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import seed  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _cleanup_tmp() -> Iterator[None]:
    yield
    engine.dispose()
    shutil.rmtree(_TMP_DIR, ignore_errors=True)


@pytest.fixture(scope="session")
def settings() -> Settings:
    return get_settings()


@pytest.fixture(scope="session")
def db_engine() -> Engine:
    init_db()
    return engine


@pytest.fixture
def session(db_engine: Engine) -> Iterator[Session]:
    with SessionLocal() as db_session:
        yield db_session


@pytest.fixture
def seeded_session(session: Session, settings: Settings) -> Session:
    """A session over a freshly seeded table (17 generated + 3 sample rows)."""
    seed(session, settings, force=True)
    return session


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    """Runs the app lifespan, which creates the table and seeds it."""
    with TestClient(app) as test_client:
        yield test_client
