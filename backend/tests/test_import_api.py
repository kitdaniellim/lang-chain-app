"""The import contract: POST /invoices/import previews, POST /invoices/bulk writes."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fixture_files import build_weird_xlsx, read_fixture

from app.config import Settings
from app.db import SessionLocal
from app.routers.invoices import MAX_UPLOAD_BYTES
from app.seed import seed

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture(autouse=True)
def reset_rows(settings: Settings) -> Iterator[None]:
    """Every test starts from the same 20 seeded rows."""
    with SessionLocal() as session:
        seed(session, settings, force=True)
    yield


def upload(client: TestClient, name: str, data: bytes, mime: str = "text/csv") -> Any:
    return client.post("/invoices/import", files={"file": (name, data, mime)})


def preview_for(client: TestClient, name: str) -> dict[str, Any]:
    data = build_weird_xlsx() if name.endswith(".xlsx") else read_fixture(name)
    mime = XLSX_MIME if name.endswith(".xlsx") else "text/csv"
    response = upload(client, name, data, mime)
    assert response.status_code == 200, response.text
    return response.json()


def drafts_to_bulk(preview: dict[str, Any]) -> dict[str, Any]:
    return {"invoices": [draft["invoice"] for draft in preview["invoices"]]}


def test_import_previews_a_vendor_summary_csv(client: TestClient) -> None:
    body = preview_for(client, "vendor_export.csv")

    assert body["mapping_source"] == "heuristic"
    assert body["model"] is None
    assert body["row_count"] == 4
    assert body["headers"][0] == "Supplier"
    assert body["mapping"]["invoice_number"] == "Inv No"
    assert body["mapping"]["date_format"] == "DMY"
    assert [draft["invoice"]["invoice_number"] for draft in body["invoices"]] == [
        "NG-8801", "BP-8802", "MF-8803", "CF-8804",
    ]
    assert body["invoices"][0]["invoice"]["total"] == 1234.50
    assert body["invoices"][0]["source_rows"] == [2]


def test_import_groups_a_line_item_csv(client: TestClient) -> None:
    body = preview_for(client, "line_items_export.csv")

    assert body["row_count"] == 5
    assert body["mapping"]["granularity"] == "line_item"
    assert len(body["invoices"]) == 2
    assert [len(draft["invoice"]["line_items"]) for draft in body["invoices"]] == [3, 2]
    assert body["invoices"][0]["import_notes"]


def test_import_previews_nested_json(client: TestClient) -> None:
    body = preview_for(client, "erp_export.json")

    assert body["row_count"] == 2
    assert body["mapping"]["vendor_name"] == "vendor.name"
    assert body["mapping"]["line_items_json"] == "lines"
    assert [draft["needs_review"] for draft in body["invoices"]] == [False, False]


def test_import_previews_an_xlsx_with_unfamiliar_headers(client: TestClient) -> None:
    body = preview_for(client, "weird.xlsx")

    assert body["row_count"] == 2
    assert body["mapping"]["total"] == "Total Incl. Tax"
    assert body["invoices"][0]["invoice"]["vendor_name"] == "Emberly Marketing"


def test_import_rejects_an_executable(client: TestClient) -> None:
    response = upload(client, "payload.exe", b"MZ\x00\x00", "application/octet-stream")

    assert response.status_code == 415
    assert "Unsupported file type" in response.json()["error"]


def test_import_rejects_an_empty_csv(client: TestClient) -> None:
    response = upload(client, "empty.csv", b"")

    assert response.status_code == 422
    assert "error" in response.json()


def test_import_rejects_a_header_only_csv(client: TestClient) -> None:
    response = upload(client, "headers.csv", b"Invoice,Vendor,Total\n")

    assert response.status_code == 422
    assert "no data rows" in response.json()["error"]


def test_import_rejects_an_oversized_file(client: TestClient) -> None:
    response = upload(client, "huge.csv", b"x" * (MAX_UPLOAD_BYTES + 1))

    assert response.status_code == 413
    assert "the limit is" in response.json()["error"]


def test_bulk_creates_every_draft_as_imported(client: TestClient) -> None:
    payload = drafts_to_bulk(preview_for(client, "vendor_export.csv"))

    response = client.post("/invoices/bulk", json=payload)
    body = response.json()

    assert response.status_code == 201
    assert len(body["created"]) == 4
    assert body["skipped"] == []
    assert {row["source"] for row in body["created"]} == {"imported"}
    # Summary-level imports are not flagged merely for lacking line items.
    assert not all(row["needs_review"] for row in body["created"])

    listed = {row["invoice_number"] for row in client.get("/invoices").json()}
    assert {"NG-8801", "BP-8802", "MF-8803", "CF-8804"} <= listed


def test_bulk_keeps_derived_line_items(client: TestClient) -> None:
    payload = drafts_to_bulk(preview_for(client, "line_items_export.csv"))

    body = client.post("/invoices/bulk", json=payload).json()
    created = {row["invoice_number"]: row for row in body["created"]}

    assert len(created["LI-3001"]["line_items"]) == 3
    assert created["LI-3001"]["subtotal"] == 1000.0
    assert created["LI-3001"]["needs_review"] is False


def test_reposting_the_same_batch_skips_every_row(client: TestClient) -> None:
    payload = drafts_to_bulk(preview_for(client, "vendor_export.csv"))
    client.post("/invoices/bulk", json=payload)

    response = client.post("/invoices/bulk", json=payload)
    body = response.json()

    assert response.status_code == 201
    assert body["created"] == []
    assert len(body["skipped"]) == 4
    assert all("already exists" in row["reason"] for row in body["skipped"])
    assert {row["invoice_number"] for row in body["skipped"]} == {
        "NG-8801", "BP-8802", "MF-8803", "CF-8804",
    }


def test_a_mixed_batch_is_partially_created(client: TestClient) -> None:
    payload = drafts_to_bulk(preview_for(client, "vendor_export.csv"))
    client.post("/invoices/bulk", json={"invoices": payload["invoices"][:2]})

    body = client.post("/invoices/bulk", json=payload).json()

    assert [row["invoice_number"] for row in body["created"]] == ["MF-8803", "CF-8804"]
    assert [row["invoice_number"] for row in body["skipped"]] == ["NG-8801", "BP-8802"]


def test_a_duplicate_inside_one_batch_is_skipped(client: TestClient) -> None:
    payload = drafts_to_bulk(preview_for(client, "vendor_export.csv"))
    payload["invoices"].append(payload["invoices"][0])

    body = client.post("/invoices/bulk", json=payload).json()

    assert len(body["created"]) == 4
    assert body["skipped"] == [
        {"invoice_number": "NG-8801", "reason": "This number appears twice in the batch."}
    ]


def test_bulk_rejects_an_empty_list(client: TestClient) -> None:
    response = client.post("/invoices/bulk", json={"invoices": []})

    assert response.status_code == 422
    assert "invoices" in response.json()["error"]


# --------------------------------------------------------------------------- POST /invoices/ingest


def ingest(client: TestClient, name: str, data: bytes, mime: str = "application/octet-stream") -> Any:
    return client.post("/invoices/ingest", files={"file": (name, data, mime)})


def test_ingest_routes_exports_through_column_mapping(client: TestClient) -> None:
    response = ingest(client, "vendor_export.csv", read_fixture("vendor_export.csv"), "text/csv")
    body = response.json()

    assert response.status_code == 200
    assert body["kind"] == "imported"
    assert body["mapping_source"] == "heuristic"  # no API key in tests
    assert body["mapping"]["invoice_number"] == "Inv No"
    assert body["raw_text"] is None
    assert len(body["invoices"]) == 4


def test_ingest_routes_documents_through_extraction(client: TestClient) -> None:
    text = b"INVOICE\nInvoice Number: X-1\nVendor: Somebody\nTotal Due: 10.00\n" * 2
    response = ingest(client, "scan.txt", text, "text/plain")

    # Extraction needs Claude; without a key the endpoint says so instead of guessing.
    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["error"]


def test_ingest_rejects_unknown_types_and_empty_documents(client: TestClient) -> None:
    assert ingest(client, "virus.exe", b"MZ").status_code == 415
    assert ingest(client, "blank.txt", b"   \n", "text/plain").status_code == 422


def test_bulk_stamps_the_requested_source(client: TestClient) -> None:
    preview = preview_for(client, "vendor_export.csv")
    payload = drafts_to_bulk(preview)
    payload["invoices"] = payload["invoices"][:1]
    payload["source"] = "uploaded"

    body = client.post("/invoices/bulk", json=payload).json()

    assert body["created"][0]["source"] == "uploaded"
    # An extracted document without line items is flagged, unlike a summary-level import.
    assert body["created"][0]["needs_review"] is True
