"""The Detector interface — the one extension point for detection techniques.

Every detection technique (sender intelligence, attachment analysis, GSTIN detection,
negative classification, and future OCR/AI) is a ``Detector`` that turns an
:class:`~core.email_document.EmailDocument` into zero or more :class:`~core.signal.Signal`
objects. Detectors never make the final decision — they only contribute evidence.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from core.config import Config
from core.email_document import EmailDocument
from core.signal import Signal
from core.store import Store


class DetectorContext:
    """Read-only services handed to every detector on each call.

    Holds the validated configuration plus optional stateful stores. Kept as a simple
    container so detectors stay pure functions of ``(document, context)``.
    """

    def __init__(
        self,
        config: Config,
        vendor_store: Store | None = None,
        dedup_store: Store | None = None,
    ) -> None:
        self.config = config
        self.vendor_store = vendor_store
        self.dedup_store = dedup_store


class Detector(ABC):
    """Base class for all detectors.

    Subclasses set the class attributes ``detector_id`` and ``layer`` and implement
    :meth:`detect`. The ``detector_id`` must match an entry in ``config/detectors.yaml``
    and is how the registry wires configuration (enabled flag, weight) to the plugin.
    """

    #: Unique id, matching config/detectors.yaml (e.g. "trusted_vendor").
    detector_id: str = ""
    #: Logical layer used for weighting and corroboration (e.g. "vendor").
    layer: str = ""

    def __init__(self) -> None:
        if not self.detector_id:
            raise ValueError(f"{type(self).__name__} must define a non-empty detector_id")
        if not self.layer:
            raise ValueError(f"{type(self).__name__} must define a non-empty layer")

    @abstractmethod
    def detect(self, doc: EmailDocument, ctx: DetectorContext) -> list[Signal]:
        """Return evidence signals for ``doc`` (possibly empty)."""

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"<Detector {self.detector_id} layer={self.layer}>"
