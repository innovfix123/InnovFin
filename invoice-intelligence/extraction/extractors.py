"""Deterministic content extractors (no OCR, no AI) + PDF page rendering for OCR."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET


def _localname(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _el_to_obj(el):
    children = list(el)
    if not children:
        return (el.text or "").strip()
    node: dict = {}
    for child in children:
        tag = _localname(child.tag)
        value = _el_to_obj(child)
        if tag in node:
            if not isinstance(node[tag], list):
                node[tag] = [node[tag]]
            node[tag].append(value)
        else:
            node[tag] = value
    return node


def extract_xml(data: bytes) -> tuple[str, dict]:
    root = ET.fromstring(data)
    structured = {_localname(root.tag): _el_to_obj(root)}
    text = " ".join(t.strip() for t in root.itertext() if t and t.strip())
    return text, structured


def extract_json(data: bytes) -> tuple[str, dict]:
    obj = json.loads(data.decode("utf-8", "ignore"))
    structured = obj if isinstance(obj, dict) else {"_root": obj}
    return json.dumps(obj, ensure_ascii=False), structured


def extract_digital_pdf(data: bytes) -> str:
    import fitz  # PyMuPDF

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def render_pdf_pages_png(data: bytes, dpi: int = 200) -> list[bytes]:
    """Render each PDF page to a PNG (used to feed a scanned PDF to OCR)."""
    import fitz

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return [page.get_pixmap(dpi=dpi).tobytes("png") for page in doc]
    finally:
        doc.close()
