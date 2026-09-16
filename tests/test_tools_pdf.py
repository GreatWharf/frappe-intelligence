"""Synthetic public PDF bytes only. Parser tests run when pypdf is installed."""

import io

import pytest


def make_pdf(*, pages=1, password=None, text="Approved content"):
    pypdf = pytest.importorskip("pypdf")
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = pypdf.PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(width=100, height=100)
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 10 10 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    if password:
        writer.encrypt(password)
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def test_real_pdf_worker_extracts_only_bounded_text():
    from frappe_intelligence.tools.attachments import parse_pdf

    result = parse_pdf(make_pdf(text="Approved content"), 8)
    assert result["content"] == "Approved"
    assert result["truncated"] is True
    assert result["pages"] == 1


@pytest.mark.parametrize("kind", ["encrypted", "too_many_pages", "malformed", "not_pdf"])
def test_pdf_worker_rejects_unsafe_or_invalid_inputs(kind):
    from frappe_intelligence.tools.attachments import parse_pdf

    data = {
        "encrypted": lambda: make_pdf(password="private"),
        "too_many_pages": lambda: make_pdf(pages=51),
        "malformed": lambda: b"%PDF-1.7\nnot-a-pdf",
        "not_pdf": lambda: b"plain text",
    }[kind]()
    with pytest.raises(ValueError):
        parse_pdf(data, 100)


def test_pdf_timeout_always_cleans_up_worker(monkeypatch):
    import frappe_intelligence.tools.attachments as attachments

    events = []

    class Connection:
        def close(self):
            events.append("close")

        def poll(self, timeout):
            assert timeout <= 8
            return False

    class Process:
        pid = 42
        alive = True

        def start(self):
            events.append("start")

        def is_alive(self):
            return self.alive

        def terminate(self):
            events.append("terminate")
            self.alive = False

        def join(self, timeout):
            events.append("join")

        def close(self):
            events.append("closed process")

    class Context:
        def Pipe(self, duplex):
            assert duplex is False
            return Connection(), Connection()

        def Process(self, target, args, daemon):
            assert daemon is True
            assert target is attachments._pdf_worker
            return Process()

    monkeypatch.setattr(attachments.multiprocessing, "get_context", lambda kind: Context())
    with pytest.raises(ValueError, match="resource limits"):
        attachments.parse_pdf(b"%PDF-1.7\n", 10)
    assert "terminate" in events and "closed process" in events
