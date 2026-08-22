"""The HTTP contract from SPEC section 4, with no API key configured."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import SessionLocal
from app.raw_samples import RAW_SAMPLES
from app.seed import seed


@pytest.fixture(autouse=True)
def reset_rows(settings: Settings) -> Iterator[None]:
    """Every API test starts from the same 20 seeded rows."""
    with SessionLocal() as session:
        seed(session, settings, force=True)
    yield


def valid_draft(invoice_number: str = "MAN-9001") -> dict:
    draft = RAW_SAMPLES[0].expected.model_dump(mode="json")
    draft["invoice_number"] = invoice_number
    draft["raw_text"] = "pasted by hand"
    return draft


def test_health_reports_the_database_and_the_missing_key(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body == {"ok": True, "database": "sqlite", "llm_configured": False, "model": "claude-sonnet-5"}


def test_list_invoices_returns_a_page_of_seeded_rows(client: TestClient) -> None:
    response = client.get("/invoices")
    body = response.json()

    assert response.status_code == 200
    assert (body["total"], body["page"], body["page_size"]) == (20, 1, 25)
    assert len(body["items"]) == 20
    first = body["items"][0]
    assert {"id", "invoice_number", "vendor_name", "total", "currency", "status"} <= set(first)
    assert first["source"] in {"seed", "seed-fallback"}
    assert isinstance(first["review_notes"], list)


def test_list_invoices_paginates_and_filters(client: TestClient) -> None:
    page2 = client.get("/invoices", params={"page": 2, "page_size": 8}).json()
    assert (page2["total"], page2["page"], len(page2["items"])) == (20, 2, 8)
    page3 = client.get("/invoices", params={"page": 3, "page_size": 8}).json()
    assert len(page3["items"]) == 4

    paid = client.get("/invoices", params={"status": "paid", "page_size": 200}).json()
    assert paid["total"] == len(paid["items"]) > 0
    assert {row["status"] for row in paid["items"]} == {"paid"}

    flagged = client.get("/invoices", params={"needs_review": "true"}).json()
    assert flagged["total"] == 1 and flagged["items"][0]["needs_review"] is True

    vendor = flagged["items"][0]["vendor_name"]
    found = client.get("/invoices", params={"q": vendor[:6].lower()}).json()
    assert any(row["vendor_name"] == vendor for row in found["items"])
    assert client.get("/invoices", params={"q": "zzz-no-such-vendor"}).json()["total"] == 0

    cheapest_first = client.get("/invoices", params={"sort": "total", "order": "asc", "page_size": 3}).json()
    totals = [row["total"] for row in cheapest_first["items"]]
    assert totals == sorted(totals)

    assert client.get("/invoices", params={"status": "bogus"}).status_code == 422
    assert client.get("/invoices", params={"page": 0}).status_code == 422


def test_extract_without_a_key_is_503(client: TestClient) -> None:
    response = client.post("/invoices/extract", json={"text": RAW_SAMPLES[0].text})

    assert response.status_code == 503
    assert response.json() == {"error": "ANTHROPIC_API_KEY is not set"}


def test_extract_rejects_text_that_is_too_short(client: TestClient) -> None:
    response = client.post("/invoices/extract", json={"text": "too short"})

    assert response.status_code == 422
    assert "text" in response.json()["error"]


def test_chat_without_a_key_is_503(client: TestClient) -> None:
    response = client.post("/chat", json={"question": "What is the total outstanding balance?"})

    assert response.status_code == 503
    assert response.json() == {"error": "ANTHROPIC_API_KEY is not set"}


def test_chat_rejects_an_empty_question(client: TestClient) -> None:
    assert client.post("/chat", json={"question": ""}).status_code == 422


def test_creating_an_invoice_returns_201_and_lists_it(client: TestClient) -> None:
    response = client.post("/invoices", json=valid_draft())
    created = response.json()

    assert response.status_code == 201
    assert created["invoice_number"] == "MAN-9001"
    assert created["source"] == "uploaded"
    assert created["needs_review"] is False
    assert created["review_notes"] == []
    assert created["total"] == 7079.55

    listed = client.get("/invoices", params={"page_size": 200}).json()["items"]
    assert len(listed) == 21
    assert listed[0]["invoice_number"] == "MAN-9001"


def test_a_suspicious_invoice_is_saved_but_flagged(client: TestClient) -> None:
    draft = valid_draft("MAN-9002")
    draft["total"] = 1.0
    created = client.post("/invoices", json=draft).json()

    assert created["needs_review"] is True
    assert any("total reads 1.00" in note for note in created["review_notes"])


def test_creating_an_invoice_with_a_bad_body_is_422(client: TestClient) -> None:
    draft = valid_draft("MAN-9003")
    draft["invoice_date"] = "not-a-date"
    response = client.post("/invoices", json=draft)

    assert response.status_code == 422
    assert "invoice_date" in response.json()["error"]


def test_duplicate_invoice_numbers_are_409(client: TestClient) -> None:
    assert client.post("/invoices", json=valid_draft("MAN-9004")).status_code == 201
    response = client.post("/invoices", json=valid_draft("MAN-9004"))

    assert response.status_code == 409
    assert "already exists" in response.json()["error"]


def test_uploading_a_text_file_reaches_the_llm_gate(client: TestClient) -> None:
    files = {"file": ("invoice.txt", RAW_SAMPLES[1].text.encode("utf-8"), "text/plain")}
    response = client.post("/invoices/upload", files=files)

    assert response.status_code == 503
    assert response.json() == {"error": "ANTHROPIC_API_KEY is not set"}


def test_uploading_an_executable_is_415(client: TestClient) -> None:
    files = {"file": ("payload.exe", b"MZ\x90\x00" * 100, "application/octet-stream")}
    response = client.post("/invoices/upload", files=files)

    assert response.status_code == 415
    assert "Unsupported file type" in response.json()["error"]


def test_uploading_something_too_large_is_413(client: TestClient) -> None:
    files = {"file": ("big.txt", b"x" * (2 * 1024 * 1024 + 1), "text/plain")}
    response = client.post("/invoices/upload", files=files)

    assert response.status_code == 413
    assert "limit is" in response.json()["error"]


def test_uploading_an_almost_empty_file_is_422(client: TestClient) -> None:
    files = {"file": ("tiny.md", b"hi", "text/markdown")}
    response = client.post("/invoices/upload", files=files)

    assert response.status_code == 422
    assert "characters of text" in response.json()["error"]


def test_unknown_routes_use_the_error_envelope(client: TestClient) -> None:
    response = client.get("/nope")

    assert response.status_code == 404
    assert response.json() == {"error": "Not Found"}
