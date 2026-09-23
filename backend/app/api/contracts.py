"""Validated wire envelopes and output-only personal-data redaction."""

import math
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


AUDIO_FORMAT = {"encoding": "pcm_s16le", "sample_rate_hz": 24000, "channels": 1}
_EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
_IIN = re.compile(r"(?<!\d)\d{12}(?!\d)")
_PHONE = re.compile(r"(?<!\w)(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)")
_PRIVATE_KEYS = {"iin", "phone", "phone_number", "email", "new_phone", "new_email", "client_iin"}


def redact(value: Any, key: str = "") -> Any:
    if key.lower() in _PRIVATE_KEYS and value is not None:
        return "[redacted]"
    if isinstance(value, dict):
        return {k: redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return _PHONE.sub("[phone]", _IIN.sub("[iin]", _EMAIL.sub("[email]", value)))
    return value


class ClientEvent(BaseModel):
    type: Literal["turn.text", "turn.start", "turn.commit", "playback.started"]
    turn_id: str | None = Field(default=None, min_length=1, max_length=128)
    payload: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_payload(self):
        if self.type.startswith("turn.") and not self.turn_id:
            raise ValueError("turn_id is required")
        if self.type == "turn.text":
            text = self.payload.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 16000:
                raise ValueError("text must be non-empty and at most 16000 characters")
        if self.type == "turn.start" and self.payload.get("mode") != "audio":
            raise ValueError("turn.start requires audio mode")
        if self.type == "playback.started":
            value = self.payload.get("latency_ms")
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or value < 0 or value > 3_600_000 or not math.isfinite(value)):
                raise ValueError("latency_ms must be finite and nonnegative")
        return self


class ServerEvent(BaseModel):
    type: str
    turn_id: str | None
    seq: int
    payload: dict[str, Any]


def frontend_status(status: str) -> str:
    return {"completed": "answered", "collecting_slots": "clarify",
            "awaiting_confirmation": "clarify", "clarifying": "clarify",
            "handoff": "handoff"}.get(status, "error")
