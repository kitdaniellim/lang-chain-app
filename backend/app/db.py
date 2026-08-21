"""Engine / session wiring. One code path for SQLite and Postgres via SQLAlchemy 2.x."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.models import Base


def make_engine(url: str) -> Engine:
    """Build an engine for `url`; SQLite needs the cross-thread guard relaxed for FastAPI."""
    kwargs: dict[str, Any] = {"pool_pre_ping": True, "future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    return create_engine(url, **kwargs)


engine: Engine = make_engine(get_settings().effective_database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(target: Engine | None = None) -> None:
    """Create the table if it is missing. `migrations/001_invoices.sql` is the hand-applied twin."""
    Base.metadata.create_all(target or engine)


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a session that always closes."""
    with SessionLocal() as session:
        yield session
