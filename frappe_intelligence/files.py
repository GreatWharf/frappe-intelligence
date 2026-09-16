"""Private conversation attachments; upload never implies model access."""

import re
from pathlib import PurePosixPath

import frappe

from .access import get_conversation, get_settings, require_user
from .limits import MAX_UPLOAD_BYTES, upload_limit_bytes

ALLOWED_EXTENSIONS = frozenset({".pdf", ".txt", ".md", ".csv", ".json"})
HARD_LIMIT = MAX_UPLOAD_BYTES


def validate_upload(filename, content, maximum):
    if not isinstance(filename, str) or not isinstance(content, bytes) or not content:
        frappe.throw("Choose a non-empty PDF or text file.")
    if len(content) > min(int(maximum), HARD_LIMIT):
        frappe.throw("This file exceeds the attachment size limit.")
    name = PurePosixPath(filename.replace("\\", "/")).name
    name = re.sub(r"[^\w. -]", "_", name)[:120]
    suffix = PurePosixPath(name).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        frappe.throw("Only PDF, TXT, Markdown, CSV and JSON attachments are supported.")
    if suffix == ".pdf":
        if not content.startswith(b"%PDF-"):
            frappe.throw("The attachment is not a valid PDF file.")
    else:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            frappe.throw("Text attachments must use UTF-8 encoding.")
        if "\x00" in text:
            frappe.throw("Binary content is not allowed in text attachments.")
    return name


def guard_file(doc, method=None):
    previous = getattr(doc, "get_doc_before_save", None)
    old = previous() if callable(previous) else None
    if old and old.get("attached_to_doctype") == "Intelligence Conversation":
        if (
            doc.get("attached_to_doctype") != old.attached_to_doctype
            or doc.get("attached_to_name") != old.attached_to_name
        ):
            frappe.throw("Intelligence attachments cannot be moved to another record.")
    if doc.get("attached_to_doctype") != "Intelligence Conversation":
        return
    require_user()
    get_conversation(doc.get("attached_to_name"), write=True)
    if not doc.get("is_private"):
        frappe.throw("Intelligence attachments must remain private.")


def upload_attachment(conversation):
    require_user()
    chat = get_conversation(conversation, write=True)
    if chat.archived:
        frappe.throw("Unarchive this conversation before uploading attachments.")
    if (
        frappe.db.count(
            "File", {"attached_to_doctype": "Intelligence Conversation", "attached_to_name": chat.name}
        )
        >= 20
    ):
        frappe.throw("This conversation already has 20 attachments.")
    uploaded = frappe.request.files.get("file")
    if not uploaded:
        frappe.throw("Choose a file to upload.")
    maximum = upload_limit_bytes(get_settings())
    content = uploaded.stream.read(maximum + 1)
    name = validate_upload(uploaded.filename, content, maximum)
    from frappe.utils.file_manager import save_file

    saved = save_file(name, content, "Intelligence Conversation", chat.name, is_private=1)
    return {key: saved.get(key) for key in ("name", "file_name", "file_url", "is_private")}


def list_attachments(conversation):
    get_conversation(conversation)
    return frappe.get_all(
        "File",
        filters={
            "attached_to_doctype": "Intelligence Conversation",
            "attached_to_name": conversation,
            "is_private": 1,
        },
        fields=["name", "file_name", "file_url", "is_private", "file_size"],
        order_by="creation asc",
        limit_page_length=20,
    )
