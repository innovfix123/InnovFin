"""Detector plugins, grouped by layer.

Importing this package registers every detector with the global registry (via the
``@register_detector`` decorator), so `import detectors` must run before building the
registry from configuration. The FilterEngine does this automatically.
"""

from detectors import (  # noqa: F401  (imported for registration side effects)
    sender,
    auth,
    subject,
    body,
    attachment,
    pattern,
    thread,
    negative,
    duplicate,
)

__all__ = [
    "sender",
    "auth",
    "subject",
    "body",
    "attachment",
    "pattern",
    "thread",
    "negative",
    "duplicate",
]
