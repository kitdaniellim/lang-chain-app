"""The natural-language SQL agent: `langchain.agents.create_agent` + the three read-only tools.

`create_agent` builds a LangGraph ReAct loop; Claude picks tools, we capture the SQL it actually ran.
"""

from __future__ import annotations

from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from sqlalchemy import Engine

from app.config import Settings
from app.extraction import LLMNotConfigured, build_chat_model
from app.schemas import ChatResponse
from app.sql_tools import build_sql_tools, column_names, get_executed_sql, reset_executed_sql
from app.validation import today

RECURSION_LIMIT = 12
TABLE = "invoices"


class AgentError(RuntimeError):
    """The agent run failed: the caller should answer 502."""


def build_system_prompt(engine: Engine) -> str:
    """Introspect the live table so the prompt is accurate on both SQLite and Postgres."""
    columns = column_names(engine, TABLE)
    column_line = ", ".join(columns) if columns else "(table not created yet)"
    return (
        "You are a data analyst answering questions about a company's invoices with SQL.\n"
        f"Today is {today().isoformat()}.\n"
        f"The only table you need is `{TABLE}` with columns: {column_line}.\n"
        "Facts about the data:\n"
        "- status is exactly one of 'paid', 'pending', 'overdue'.\n"
        "- 'outstanding' or 'unpaid' means status != 'paid'.\n"
        "- Amounts (subtotal, tax, total) are stored in the currency named by that row's currency column, "
        "so group or label by currency instead of summing different currencies together.\n"
        "- line_items is JSON; prefer the numeric columns over parsing it.\n"
        "- needs_review flags rows our validator found suspicious.\n"
        "How to work:\n"
        "- Use run_sql for every fact. Never guess or invent numbers.\n"
        "- If you are unsure about a column, call list_tables or describe_table first.\n"
        "- Only SELECT queries are permitted; the connection is read-only.\n"
        "- Then answer in 1-3 sentences, quoting the actual numbers with their currency. Be concise.\n"
        "- Plain text only: no markdown, no bold, no bullet symbols (the UI renders your words verbatim)."
    )


def build_agent(engine: Engine, model: BaseChatModel, settings: Settings):
    """Wire the model, the three SQL tools and the introspected prompt into one agent."""
    return create_agent(
        model,
        build_sql_tools(engine, settings),
        system_prompt=build_system_prompt(engine),
    )


def _message_text(message: BaseMessage) -> str:
    """Flatten content that may arrive as a string or as a list of content blocks."""
    content = message.content
    if isinstance(content, str):
        return content.strip()
    parts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "".join(parts).strip()


def ask(
    question: str, engine: Engine, settings: Settings, model: BaseChatModel | None = None
) -> ChatResponse:
    """Run one question through the agent and report the answer plus the SQL it executed."""
    chat = model if model is not None else build_chat_model(settings)
    reset_executed_sql()
    agent = build_agent(engine, chat, settings)
    try:
        state = agent.invoke(
            {"messages": [HumanMessage(question)]}, config={"recursion_limit": RECURSION_LIMIT}
        )
    except LLMNotConfigured:
        raise
    except Exception as exc:
        raise AgentError(f"The SQL agent failed: {exc}") from exc

    answer = next(
        (
            text
            for message in reversed(state["messages"])
            if isinstance(message, AIMessage) and (text := _message_text(message))
        ),
        "",
    )
    if not answer:
        raise AgentError("The agent finished without producing an answer.")
    return ChatResponse(answer=answer, sql_query_used=";\n".join(get_executed_sql()))
