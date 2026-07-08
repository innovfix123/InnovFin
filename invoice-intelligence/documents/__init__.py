"""Document access abstraction for the Invoice Intelligence pipeline.

Downstream modules (document typing, OCR / text extraction, AI understanding) MUST depend
only on :class:`~documents.provider.DocumentProvider`. They receive an opaque
:class:`~documents.models.DocumentRef` and ask the provider for bytes / metadata — they never
see a filesystem path or the blob store. Storage can change (filesystem → S3 → DB) by swapping
the provider implementation, with zero change to OCR/AI.
"""

from documents.models import DocumentMetadata, DocumentRef
from documents.provider import DocumentProvider, RegistryDocumentProvider

__all__ = [
    "DocumentRef",
    "DocumentMetadata",
    "DocumentProvider",
    "RegistryDocumentProvider",
]
