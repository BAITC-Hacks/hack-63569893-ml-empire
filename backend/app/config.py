"""Application startup settings."""

from dataclasses import dataclass, field
from pathlib import Path


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
    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    router_model: str = "gpt-6-sol"
    router_timeout_seconds: float = 15.0

    def __post_init__(self) -> None:
        data_dir = Path(self.data_dir)
        if not data_dir.is_dir():
            raise ValueError(f"data_dir does not exist: {data_dir}")
        missing = [name for name in REQUIRED_DATA_FILES if not (data_dir / name).is_file()]
        if missing:
            raise ValueError(f"data_dir is missing required files: {', '.join(missing)}")
        if not self.router_model.strip():
            raise ValueError("router_model must not be blank")
        if self.router_timeout_seconds <= 0:
            raise ValueError("router_timeout_seconds must be positive")
        object.__setattr__(self, "data_dir", data_dir)
