"""OCRProvider interface + the default Tesseract implementation.

Tesseract is the default, deterministic, LOCAL OCR engine (no recurring cost, no data leaves
the machine). Cloud providers (Claude Vision, Google Document AI, Azure, AWS Textract, OpenAI
Vision) are OPTIONAL plugins — registered here in future, never integrated by default.
"""

from __future__ import annotations

import io
import os
import shutil
from typing import Any, Protocol, runtime_checkable

from core.config import ConfigError
from extraction.models import OcrResult

# Common Windows install locations for the UB-Mannheim Tesseract build, tried when the binary
# is neither configured nor on PATH. Keeps the health check green without shell PATH surgery.
_KNOWN_TESSERACT_PATHS = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Programs\Tesseract-OCR\tesseract.exe"),
)


def resolve_tesseract_binary(binary_path: str | None = None) -> str | None:
    """Locate the Tesseract executable: explicit config -> PATH -> known install dirs."""
    if binary_path and os.path.isfile(binary_path):
        return binary_path
    on_path = shutil.which("tesseract")
    if on_path:
        return on_path
    for candidate in _KNOWN_TESSERACT_PATHS:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


@runtime_checkable
class OCRProvider(Protocol):
    name: str

    def available(self) -> bool:
        """True only if this provider can actually run (e.g. the Tesseract binary is present)."""

    def image_to_text(self, image_bytes: bytes) -> OcrResult:
        ...


class TesseractOCRProvider:
    """Local OCR via the Tesseract binary (through pytesseract)."""

    name = "tesseract"

    def __init__(self, lang: str = "eng", config: str = "", binary_path: str | None = None) -> None:
        self.lang = lang
        self.config = config
        self.binary_path = binary_path

    def _bind(self) -> str | None:
        """Point pytesseract at the resolved binary and return its path (or None)."""
        path = resolve_tesseract_binary(self.binary_path)
        if path is None:
            return None
        try:
            import pytesseract
            pytesseract.pytesseract.tesseract_cmd = path
        except Exception:
            return None
        return path

    def version(self) -> str | None:
        """Real runtime probe: the Tesseract engine version, or None if unavailable."""
        if self._bind() is None:
            return None
        try:
            import pytesseract
            return str(pytesseract.get_tesseract_version())
        except Exception:
            return None

    def available(self) -> bool:
        if self._bind() is None:
            return False
        try:
            import PIL  # noqa: F401
            import pytesseract  # noqa: F401
        except Exception:
            return False
        # A resolved path + importable libs is not enough; confirm the engine actually runs.
        return self.version() is not None

    def image_to_text(self, image_bytes: bytes) -> OcrResult:
        import pytesseract
        from PIL import Image

        self._bind()
        img = Image.open(io.BytesIO(image_bytes))
        data = pytesseract.image_to_data(
            img, lang=self.lang, config=self.config, output_type=pytesseract.Output.DICT
        )
        words, confs = [], []
        for text, conf in zip(data.get("text", []), data.get("conf", [])):
            if text and text.strip():
                words.append(text)
                try:
                    value = float(conf)
                except (TypeError, ValueError):
                    value = -1.0
                if value >= 0:
                    confs.append(value)
        mean = (sum(confs) / len(confs) / 100.0) if confs else 0.0
        return OcrResult(text=" ".join(words), confidence=mean)


# Default local provider only. Cloud providers plug in here when explicitly approved.
_OCR_PROVIDERS = {"tesseract": TesseractOCRProvider}


def build_ocr_provider(settings: dict[str, Any]) -> OCRProvider:
    ocr = (settings or {}).get("ocr", {}) or {}
    name = str(ocr.get("provider", "tesseract")).lower()
    factory = _OCR_PROVIDERS.get(name)
    if factory is None:
        raise ConfigError(
            f"unknown OCR provider {name!r} (available: {sorted(_OCR_PROVIDERS)}; "
            f"cloud providers are optional plugins and not integrated)"
        )
    return factory(
        lang=ocr.get("lang", "eng"),
        config=ocr.get("tesseract_config", ""),
        binary_path=ocr.get("binary_path") or None,
    )
