"""Read-only SQL tools for the LangChain agent, written directly on SQLAlchemy.

`langchain-community`'s SQLDatabaseToolkit is being sunset, and owning the tools buys two things the
demo needs: a hard read-only guard, and exact capture of every statement for `sql_query_used`.
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import Any

import sqlalchemy as sa
from langchain_core.tools import BaseTool, tool
from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings

# Statements actually executed during the current agent turn, in order.
_executed_sql: ContextVar[list[str] | None] = ContextVar("executed_sql", default=None)

STATEMENT_TIMEOUT_MS = 10_000

# Whole-word write/DDL verbs. Checked across the entire statement so a CTE cannot smuggle one in.
FORBIDDEN_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "attach", "detach", "pragma", "replace", "merge", "vacuum", "reindex", "copy", "call", "do",
    "execute", "commit", "rollback", "savepoint", "lock", "refresh", "analyze",
)

_COMMENT_RE = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)
_STRING_RE = re.compile(r"'(?:[^']|'')*'")
_LIMIT_RE = re.compile(r"\blimit\b|\bfetch\s+first\b", re.IGNORECASE)


class ReadOnlyViolation(ValueError):
    """The submitted SQL is not a plain, single, read-only query."""


def reset_executed_sql() -> None:
    """Start a fresh capture buffer for one agent turn. Call before invoking the agent."""
    _executed_sql.set([])


def _buffer() -> list[str]:
    """LangChain runs tools in a copied context, so the buffer is mutated, never rebound."""
    buffer = _executed_sql.get()
    if buffer is None:
        buffer = []
        _executed_sql.set(buffer)
    return buffer


def get_executed_sql() -> list[str]:
    return list(_buffer())


def _record(query: str) -> None:
    _buffer().append(query)


def _strip_literals(sql: str) -> str:
    """Blank out comments and quoted strings so keyword scanning cannot false-positive on data."""
    return _STRING_RE.sub("''", _COMMENT_RE.sub(" ", sql))


def guard_query(query: str, row_limit: int) -> str:
    """Validate a read-only single statement and return it with a LIMIT enforced.

    Raises `ReadOnlyViolation` on anything that could write, chain, or run unbounded.
    """
    raw = (query or "").strip()
    if not raw:
        raise ReadOnlyViolation("Empty query.")

    scrubbed = _strip_literals(raw).strip().rstrip(";").rstrip()
    if ";" in scrubbed:
        raise ReadOnlyViolation("Multiple statements are not allowed; send one SELECT at a time.")

    if not re.match(r"^\s*(select|with)\b", scrubbed, re.IGNORECASE):
        raise ReadOnlyViolation("Only SELECT (or WITH ... SELECT) queries are allowed.")

    hit = next((k for k in FORBIDDEN_KEYWORDS if re.search(rf"\b{k}\b", scrubbed, re.IGNORECASE)), None)
    if hit is not None:
        raise ReadOnlyViolation(f"This connection is read-only; {hit.upper()} is not allowed.")

    safe = raw.rstrip().rstrip(";").rstrip()
    if not _LIMIT_RE.search(_strip_literals(safe)):
        safe = f"{safe} LIMIT {row_limit}"
    return safe


def _render_table(columns: list[str], rows: list[tuple[Any, ...]]) -> str:
    """Compact markdown table; the agent reads this straight out of the tool message."""
    if not rows:
        return "(no rows)"
    header = "| " + " | ".join(columns) + " |"
    divider = "| " + " | ".join("---" for _ in columns) + " |"
    body = [
        "| " + " | ".join("" if value is None else str(value) for value in row) + " |" for row in rows
    ]
    return "\n".join([header, divider, *body])


def table_overview(engine: Engine, table: str) -> str:
    """Column names and types for `table`, or a clear message when it does not exist."""
    inspector = sa.inspect(engine)
    if table not in inspector.get_table_names():
        return f"Table {table!r} does not exist."
    columns = inspector.get_columns(table)
    lines = [f"- {col['name']}: {col['type']}{'' if col.get('nullable', True) else ' NOT NULL'}" for col in columns]
    return f"Table {table}:\n" + "\n".join(lines)


def column_names(engine: Engine, table: str) -> list[str]:
    inspector = sa.inspect(engine)
    if table not in inspector.get_table_names():
        return []
    return [col["name"] for col in inspector.get_columns(table)]


def build_sql_tools(engine: Engine, settings: Settings) -> list[BaseTool]:
    """Bind the three tools to one engine. Returned to `create_agent` as its toolset."""

    @tool
    def list_tables() -> str:
        """List the tables available in the database."""
        names = sorted(sa.inspect(engine).get_table_names())
        return ", ".join(names) if names else "(no tables)"

    @tool
    def describe_table(table: str) -> str:
        """Show the columns, types and up to 3 sample rows of one table."""
        inspector = sa.inspect(engine)
        if table not in inspector.get_table_names():
            known = ", ".join(sorted(inspector.get_table_names()))
            return f"Table {table!r} does not exist. Available tables: {known}"
        overview = table_overview(engine, table)
        preview_sql = f'SELECT * FROM "{table}" LIMIT 3'
        try:
            with engine.connect() as conn:
                result = conn.execute(sa.text(preview_sql))
                sample = _render_table(list(result.keys()), result.fetchmany(3))
        except SQLAlchemyError as exc:
            return f"{overview}\n\nSample rows unavailable: {exc}"
        _record(preview_sql)
        return f"{overview}\n\nSample rows:\n{sample}"

    @tool
    def run_sql(query: str) -> str:
        """Run one read-only SELECT and return the rows as a markdown table."""
        try:
            safe = guard_query(query, settings.sql_row_limit)
        except ReadOnlyViolation as exc:
            return f"ERROR: {exc} Rewrite the query as a SELECT."
        try:
            with engine.connect() as conn, conn.begin():
                if conn.dialect.name == "postgresql":
                    conn.exec_driver_sql(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
                result = conn.execute(sa.text(safe))
                columns = list(result.keys())
                rows = result.fetchmany(settings.sql_row_limit)
                truncated = result.fetchone() is not None
        except SQLAlchemyError as exc:
            _record(safe)
            return f"ERROR: the query failed: {exc}"
        _record(safe)
        table = _render_table(columns, rows)
        if truncated:
            table += f"\n(truncated to {settings.sql_row_limit} rows)"
        return table

    return [list_tables, describe_table, run_sql]
