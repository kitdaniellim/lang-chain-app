"""The read-only guard and the SQL capture that feeds `sql_query_used`."""

from __future__ import annotations

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.sql_tools import (
    ReadOnlyViolation,
    build_sql_tools,
    get_executed_sql,
    guard_query,
    reset_executed_sql,
)


@pytest.fixture
def tools(db_engine: Engine, settings: Settings, seeded_session: Session):
    reset_executed_sql()
    return {tool.name: tool for tool in build_sql_tools(db_engine, settings)}


@pytest.mark.parametrize(
    "query",
    [
        "DELETE FROM invoices",
        "UPDATE invoices SET total = 0",
        "DROP TABLE invoices",
        "PRAGMA table_info(invoices)",
        "INSERT INTO invoices (id) VALUES (1)",
    ],
)
def test_writes_are_rejected(query: str) -> None:
    with pytest.raises(ReadOnlyViolation):
        guard_query(query, 50)


def test_write_hidden_in_a_cte_is_rejected() -> None:
    with pytest.raises(ReadOnlyViolation, match="DELETE"):
        guard_query("WITH gone AS (DELETE FROM invoices RETURNING *) SELECT * FROM gone", 50)


@pytest.mark.parametrize(
    "query", ["SELECT 1; DROP TABLE invoices", "SELECT 1; SELECT 2;", "SELECT 1;; DELETE FROM invoices;"]
)
def test_statement_chaining_is_rejected(query: str) -> None:
    with pytest.raises(ReadOnlyViolation, match="Multiple statements"):
        guard_query(query, 50)


def test_limit_is_appended_when_missing() -> None:
    assert guard_query("SELECT * FROM invoices", 50) == "SELECT * FROM invoices LIMIT 50"


def test_existing_limit_is_respected() -> None:
    assert guard_query("SELECT * FROM invoices LIMIT 5", 50) == "SELECT * FROM invoices LIMIT 5"
    assert guard_query("SELECT * FROM invoices LIMIT 5;", 50) == "SELECT * FROM invoices LIMIT 5"


def test_a_write_word_inside_a_string_literal_is_not_a_write() -> None:
    query = "SELECT * FROM invoices WHERE vendor_name LIKE '%update%'"
    assert guard_query(query, 50).startswith(query)


def test_run_sql_returns_a_markdown_table_and_records_the_statement(tools) -> None:
    output = tools["run_sql"].invoke({"query": "SELECT count(*) AS n FROM invoices"})
    assert "| n |" in output
    assert "| 20 |" in output
    assert get_executed_sql() == ["SELECT count(*) AS n FROM invoices LIMIT 50"]


def test_run_sql_reports_the_guard_instead_of_running_a_write(tools) -> None:
    output = tools["run_sql"].invoke({"query": "DELETE FROM invoices"})
    assert output.startswith("ERROR:")
    assert get_executed_sql() == []


def test_run_sql_surfaces_database_errors(tools) -> None:
    output = tools["run_sql"].invoke({"query": "SELECT * FROM nope"})
    assert output.startswith("ERROR: the query failed")


def test_run_sql_says_so_when_there_are_no_rows(tools) -> None:
    assert tools["run_sql"].invoke({"query": "SELECT id FROM invoices WHERE id < 0"}) == "(no rows)"


def test_run_sql_caps_the_row_count(tools, settings: Settings) -> None:
    output = tools["run_sql"].invoke({"query": "SELECT id FROM invoices LIMIT 500"})
    assert "truncated to" not in output  # only 20 rows exist
    assert output.count("\n") == 21  # header + divider + 20 rows


def test_list_tables_and_describe_table(tools) -> None:
    assert "invoices" in tools["list_tables"].invoke({})
    described = tools["describe_table"].invoke({"table": "invoices"})
    assert "invoice_number" in described
    assert "Sample rows:" in described
    assert get_executed_sql() == ['SELECT * FROM "invoices" LIMIT 3']


def test_describe_table_names_the_alternatives_for_an_unknown_table(tools) -> None:
    assert "does not exist" in tools["describe_table"].invoke({"table": "customers"})
