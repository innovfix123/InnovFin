"""DocumentProvider — the single interface OCR/AI use to read documents.

``RegistryDocumentProvider`` composes the AttachmentRegistry (records) and the blob store
(bytes). It resolves a document purely by its content hash, so no caller ever learns where the
bytes physically live.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from attachments.registry import AttachmentRegistry
from documents.models import DocumentMetadata, DocumentRef
from storage.blob_store import FilesystemBlobStore


@runtime_checkable
class DocumentProvider(Protocol):
    """Read-only access to collected documents by opaque reference."""

    def list_documents(self) -> list[DocumentRef]:
        ...

    def open(self, ref: DocumentRef | str) -> bytes:
        ...

    def metadata(self, ref: DocumentRef | str) -> DocumentMetadata:
        ...


class RegistryDocumentProvider:
    """DocumentProvider backed by an AttachmentRegistry + a content-addressed blob store."""

    def __init__(self, registry: AttachmentRegistry, blob_store: FilesystemBlobStore) -> None:
        self._registry = registry
        self._blobs = blob_store

    @property
    def registry(self) -> AttachmentRegistry:
        """The backing registry — used to resolve a doc_id back to its mailbox source_ref."""
        return self._registry

    def list_documents(self) -> list[DocumentRef]:
        return [
            DocumentRef(r.sha256, r.filename, r.attachment_type)
            for r in self._registry.all()
        ]

    def open(self, ref: DocumentRef | str) -> bytes:
        record = self._require(_doc_id(ref))
        return self._blobs.get(record.sha256)   # resolved by hash — no path exposed

    def metadata(self, ref: DocumentRef | str) -> DocumentMetadata:
        r = self._require(_doc_id(ref))
        return DocumentMetadata(
            doc_id=r.sha256,
            filename=r.filename,
            attachment_type=r.attachment_type,
            mime_type=r.mime_type,
            size=r.size,
            is_encrypted=r.is_encrypted,
            is_structured=r.attachment_type.is_structured,
            source_message_id=r.source_message_id,
            source_sender=getattr(r, "source_sender", "") or "",
            source_date=getattr(r, "source_date", "") or "",
        )

    def _require(self, doc_id: str):
        record = self._registry.get(doc_id)
        if record is None:
            raise KeyError(f"unknown document: {doc_id}")
        return record


def _doc_id(ref: DocumentRef | str) -> str:
    return ref.doc_id if isinstance(ref, DocumentRef) else str(ref)
