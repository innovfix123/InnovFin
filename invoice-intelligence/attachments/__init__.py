"""Attachment Collector (Part 2, Milestone 2.1).

Given invoice emails (from an ingestion source), extract each attachment, compute its content
hash, classify its type (PDF / XML / JSON e-invoice / image / archive / other) and store the
raw bytes. STOPS before reading attachment *contents* — document-typing (digital vs scanned)
and OCR/AI are later milestones.
"""
