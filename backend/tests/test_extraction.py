"""`with_structured_output` extraction, driven by a fake chat model."""

from __future__ import annotations

import pytest
from fakes import StructuredOutputFake

from app.config import Settings
from app.extraction import ExtractionError, LLMNotConfigured, build_chat_model, extract_invoice
from app.raw_samples import RAW_SAMPLES


def test_no_api_key_raises_llm_not_configured(settings: Settings) -> None:
    with pytest.raises(LLMNotConfigured, match="ANTHROPIC_API_KEY"):
        extract_invoice("some invoice text", settings)


def test_build_chat_model_requires_a_key(settings: Settings) -> None:
    with pytest.raises(LLMNotConfigured):
        build_chat_model(settings)


def test_extraction_returns_a_clean_invoice(settings: Settings) -> None:
    sample = RAW_SAMPLES[0]
    fake = StructuredOutputFake(invoice=sample.expected)
    result = extract_invoice(sample.text, settings, model=fake)

    assert result.invoice.invoice_number == "NW-2291"
    assert result.invoice.total == 7079.55
    assert result.notes == []
    assert result.needs_review is False
    assert result.model == settings.anthropic_model


def test_the_raw_text_reaches_the_model(settings: Settings) -> None:
    sample = RAW_SAMPLES[1]
    fake = StructuredOutputFake(invoice=sample.expected)
    extract_invoice(sample.text, settings, model=fake)

    messages = fake.calls[0].to_messages()
    assert "Never recompute" in messages[0].content
    assert "BL-2026-0417" in messages[1].content


def test_notes_are_computed_from_the_model_output(settings: Settings) -> None:
    bad = RAW_SAMPLES[0].expected.model_copy(update={"total": 1.0})
    result = extract_invoice(RAW_SAMPLES[0].text, settings, model=StructuredOutputFake(invoice=bad))

    assert result.needs_review is True
    assert any("total reads 1.00" in note for note in result.notes)


def test_money_is_rounded_to_two_places(settings: Settings) -> None:
    messy = RAW_SAMPLES[0].expected.model_copy(update={"tax": 539.5512, "total": 7079.5512})
    result = extract_invoice(RAW_SAMPLES[0].text, settings, model=StructuredOutputFake(invoice=messy))

    assert (result.invoice.tax, result.invoice.total) == (539.55, 7079.55)


def test_provider_failures_become_extraction_errors(settings: Settings) -> None:
    fake = StructuredOutputFake(error=RuntimeError("overloaded_error"))
    with pytest.raises(ExtractionError, match="overloaded_error"):
        extract_invoice("some invoice text", settings, model=fake)


def test_a_non_invoice_result_is_an_extraction_error(settings: Settings) -> None:
    fake = StructuredOutputFake(invoice=None)
    with pytest.raises(ExtractionError, match="expected Invoice"):
        extract_invoice("some invoice text", settings, model=fake)
