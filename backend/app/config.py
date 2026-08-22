"""Environment-driven settings (reads backend/.env when present)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    # One .env for the whole repo, at the repository root.
    model_config = SettingsConfigDict(env_file=str(REPO_ROOT / ".env"), env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    # Empty -> local SQLite file next to the backend.
    database_url: str = ""
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
    # Max rows a single agent query may return; keeps prompts small.
    sql_row_limit: int = Field(default=50, ge=1, le=500)

    @property
    def llm_configured(self) -> bool:
        return bool(self.anthropic_api_key.strip())

    @property
    def effective_database_url(self) -> str:
        return self.database_url.strip() or "sqlite:///./invoices.db"

    @property
    def database_kind(self) -> str:
        return "postgres" if self.effective_database_url.startswith("postgresql") else "sqlite"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
