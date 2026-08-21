"""The `create_agent` SQL loop, driven by a scripted tool-calling fake."""

from __future__ import annotations

import pytest
from fakes import scripted_model, tool_call_message
from langchain_core.messages import AIMessage
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.extraction import LLMNotConfigured
from app.query_agent import AgentError, ask, build_system_prompt
from app.seed import count_invoices


def test_no_api_key_raises_llm_not_configured(db_engine: Engine, settings: Settings) -> None:
    with pytest.raises(LLMNotConfigured):
        ask("How many invoices?", db_engine, settings)


def test_the_system_prompt_carries_the_real_columns(db_engine: Engine, seeded_session: Session) -> None:
    prompt = build_system_prompt(db_engine)
    for column in ("invoice_number", "vendor_name", "due_date", "needs_review", "currency"):
        assert column in prompt
    assert "'paid', 'pending', 'overdue'" in prompt
    assert "status != 'paid'" in prompt


def test_agent_runs_the_tool_and_reports_the_sql(
    db_engine: Engine, settings: Settings, seeded_session: Session
) -> None:
    model = scripted_model(
        tool_call_message("run_sql", {"query": "SELECT count(*) AS n FROM invoices"}),
        AIMessage(content="There are 20 invoices on file."),
    )
    response = ask("How many invoices are there?", db_engine, settings, model=model)

    assert response.answer == "There are 20 invoices on file."
    assert response.sql_query_used == "SELECT count(*) AS n FROM invoices LIMIT 50"


def test_multiple_statements_are_joined(
    db_engine: Engine, settings: Settings, seeded_session: Session
) -> None:
    model = scripted_model(
        tool_call_message("describe_table", {"table": "invoices"}, "call_1"),
        tool_call_message(
            "run_sql",
            {"query": "SELECT currency, SUM(total) AS owed FROM invoices WHERE status != 'paid' GROUP BY currency"},
            "call_2",
        ),
        AIMessage(content="Outstanding balances are grouped by currency above."),
    )
    response = ask("What is outstanding?", db_engine, settings, model=model)

    statements = response.sql_query_used.split(";\n")
    assert statements[0] == 'SELECT * FROM "invoices" LIMIT 3'
    assert statements[1].startswith("SELECT currency, SUM(total)")
    assert statements[1].endswith("LIMIT 50")


def test_a_write_attempt_is_refused_and_never_recorded(
    db_engine: Engine, settings: Settings, seeded_session: Session
) -> None:
    model = scripted_model(
        tool_call_message("run_sql", {"query": "DELETE FROM invoices"}),
        AIMessage(content="I cannot modify the data; the connection is read-only."),
    )
    response = ask("Delete every invoice", db_engine, settings, model=model)

    assert response.sql_query_used == ""
    assert count_invoices(seeded_session) == 20
    assert "read-only" in response.answer


def test_an_answer_without_any_sql_still_returns(
    db_engine: Engine, settings: Settings, seeded_session: Session
) -> None:
    model = scripted_model(AIMessage(content="I need more detail about the date range."))
    response = ask("Tell me something", db_engine, settings, model=model)

    assert response.sql_query_used == ""
    assert response.answer.startswith("I need more detail")


def test_a_model_failure_becomes_an_agent_error(
    db_engine: Engine, settings: Settings, seeded_session: Session
) -> None:
    model = scripted_model()  # the iterator is empty, so the model raises on first use
    with pytest.raises(AgentError, match="SQL agent failed"):
        ask("How many invoices?", db_engine, settings, model=model)
