"""Stand-ins for ChatAnthropic so the suite never touches the network."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable, RunnableLambda

from app.schemas import Invoice


class StructuredOutputFake:
    """Duck-types the one method `build_extractor` needs: `with_structured_output`."""

    def __init__(self, invoice: Invoice | None = None, error: Exception | None = None) -> None:
        self.invoice = invoice
        self.error = error
        self.calls: list[Any] = []

    def with_structured_output(self, schema: Any, **kwargs: Any) -> Runnable:
        def _run(prompt_value: Any) -> Invoice | None:
            self.calls.append(prompt_value)
            if self.error is not None:
                raise self.error
            return self.invoice

        return RunnableLambda(_run)


class StructuredValueFake:
    """Same trick for any schema: `with_structured_output` returns a prepared value, or raises."""

    def __init__(self, value: Any = None, error: Exception | None = None) -> None:
        self.value = value
        self.error = error
        self.calls: list[Any] = []
        self.schemas: list[Any] = []

    def with_structured_output(self, schema: Any, **kwargs: Any) -> Runnable:
        self.schemas.append(schema)

        def _run(prompt_value: Any) -> Any:
            self.calls.append(prompt_value)
            if self.error is not None:
                raise self.error
            return self.value

        return RunnableLambda(_run)


class ToolCallingFake(GenericFakeChatModel):
    """`GenericFakeChatModel` refuses `bind_tools`; the agent needs it, so return self."""

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable:
        return self


def tool_call_message(name: str, args: dict[str, Any], call_id: str = "call_1") -> AIMessage:
    """One scripted tool call for the agent loop."""
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}]
    )


def scripted_model(*messages: AIMessage) -> ToolCallingFake:
    return ToolCallingFake(messages=iter(messages))
