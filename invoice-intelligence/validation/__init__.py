"""Validation (Part 2, Milestone 2.5) — deterministic checks, no AI.

Validates canonical fields: GSTIN (format + checksum), invoice number, dates, amounts,
arithmetic reconciliation and mandatory fields; computes an overall confidence score. Anything
failing a mandatory check or below the confidence threshold is flagged for Manual Review.
"""

from validation.engine import InvoiceValidator
from validation.gstin import gstin_checksum, is_valid_gstin
from validation.models import FieldValidation, ValidationResult
from validation.relevance import InvoiceRelevance, RelevanceResult, TrustedSourceRelevance

__all__ = [
    "InvoiceValidator", "ValidationResult", "FieldValidation",
    "InvoiceRelevance", "RelevanceResult", "TrustedSourceRelevance",
    "is_valid_gstin", "gstin_checksum",
]
