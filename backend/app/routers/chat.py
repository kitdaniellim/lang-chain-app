"""Chat endpoint: one question -> the LangChain SQL agent -> answer plus the SQL it ran."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.config import Settings, get_settings
from app.db import engine
from app.extraction import LLMNotConfigured
from app.query_agent import AgentError, ask
from app.schemas import ChatRequest, ChatResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest, settings: Settings = Depends(get_settings)) -> ChatResponse:
    """Single-turn question answering over the invoices table."""
    try:
        return ask(body.question, engine, settings)
    except LLMNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except AgentError as exc:
        logger.warning("Agent run failed: %s", exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
