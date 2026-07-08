"""Validation result types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FieldValidation:
    field: str
    ok: bool
    message: str


@dataclass(frozen=True)
class ValidationResult:
    checks: tuple[FieldValidation, ...]
    errors: tuple[str, ...]        # messages of failed checks
    confidence: float             # 0..1 overall
    needs_review: bool

    @property
    def ok(self) -> bool:
        return not self.errors
