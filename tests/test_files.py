import importlib

import pytest
from test_services import services as services


def test_upload_names_are_safe_and_only_document_types_are_allowed(services):
    module = importlib.import_module("frappe_intelligence.files")
    assert module.validate_upload("../../notes.txt", b"safe text", 1024) == "notes.txt"
    for name in ("script.html", "photo.svg", "installer.exe", "unknown"):
        with pytest.raises(ValueError):
            module.validate_upload(name, b"content", 1024)


def test_upload_limits_and_content_signatures_are_enforced(services):
    module = importlib.import_module("frappe_intelligence.files")
    with pytest.raises(ValueError):
        module.validate_upload("notes.txt", b"x" * 1025, 1024)
    with pytest.raises(ValueError):
        module.validate_upload("fake.pdf", b"not a pdf", 1024)
    with pytest.raises(ValueError):
        module.validate_upload("binary.txt", b"\xff\x00\xfe", 1024)
    assert module.validate_upload("report.pdf", b"%PDF-1.7\n", 1024) == "report.pdf"


def test_existing_attachment_cannot_be_reparented_to_bypass_privacy(services):
    from test_services import Row

    module = importlib.import_module("frappe_intelligence.files")
    old = Row(attached_to_doctype="Intelligence Conversation", attached_to_name="chat", is_private=1)
    doc = Row(attached_to_doctype=None, attached_to_name=None, is_private=0)
    doc.get_doc_before_save = lambda: old
    with pytest.raises(ValueError):
        module.guard_file(doc)


def test_attached_files_cannot_be_public_or_attached_to_another_users_chat(services):
    _, store = services
    from test_services import Row

    module = importlib.import_module("frappe_intelligence.files")
    store["chat"] = Row(doctype="Intelligence Conversation", name="chat", owner="owner@example.test")
    with pytest.raises(ValueError):
        module.guard_file(
            Row(attached_to_doctype="Intelligence Conversation", attached_to_name="chat", is_private=0)
        )
    store["chat"].owner = "other@example.test"
    with pytest.raises(PermissionError):
        module.guard_file(
            Row(attached_to_doctype="Intelligence Conversation", attached_to_name="chat", is_private=1)
        )
