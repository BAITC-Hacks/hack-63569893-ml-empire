"""Application startup settings."""

from dataclasses import dataclass, field
import os
from pathlib import Path
from typing import Literal


DEFAULT_DATA_DIR = Path(__file__).resolve().parents[2] / "datas"
REQUIRED_DATA_FILES = (
    "scenarios.json",
    "actions.json",
    "slots.json",
    "knowledge_base.json",
    "mock_backend.json",
)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", DEFAULT_DATA_DIR)))
    router_model: str = field(default_factory=lambda: os.getenv("ROUTER_MODEL", "gpt-6-sol"))
    router_reasoning_effort: Literal["none", "low"] = field(
        default_factory=lambda: os.getenv("ROUTER_REASONING_EFFORT", "none")
    )
    router_timeout_seconds: float = 15.0
    frontend_origin: str = field(default_factory=lambda: os.getenv("FRONTEND_ORIGIN", "http://localhost:5173"))

    def __post_init__(self) -> None:
        data_dir = Path(self.data_dir)
        if not data_dir.is_dir():
            raise ValueError(f"data_dir does not exist: {data_dir}")
        missing = [name for name in REQUIRED_DATA_FILES if not (data_dir / name).is_file()]
        if missing:
            raise ValueError(f"data_dir is missing required files: {', '.join(missing)}")
        if not self.router_model.strip():
            raise ValueError("router_model must not be blank")
        if self.router_reasoning_effort not in ("none", "low"):
            raise ValueError("router_reasoning_effort must be none or low")
        if self.router_timeout_seconds <= 0:
            raise ValueError("router_timeout_seconds must be positive")
        if self.frontend_origin == "*" or not self.frontend_origin.startswith(("http://", "https://")):
            raise ValueError("frontend_origin must be one explicit HTTP(S) origin")
        object.__setattr__(self, "data_dir", data_dir)
