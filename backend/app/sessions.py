"""Single-process sessions and at-most-once turn admission."""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from app.api.contracts import ServerEvent, redact


class TurnRejected(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class Session:
    session_id: str
    mock_backend: dict
    last_seq: int = 0
    last_turn_id: str | None = None
    active_scenario: str | None = None
    pending_confirmation: dict | None = None
    last_trace: dict | None = None
    active_turn_id: str | None = None
    connected: bool = False
    seen_turns: set[str] = field(default_factory=set)
    results: dict[str, Any] = field(default_factory=dict)

    def claim(self, turn_id: str) -> None:
        if turn_id in self.seen_turns:
            raise TurnRejected("invalid_event")
        if self.active_turn_id is not None:
            raise TurnRejected("busy")
        self.seen_turns.add(turn_id)
        self.active_turn_id = turn_id
        self.last_turn_id = turn_id

    def release(self, turn_id: str) -> None:
        if self.active_turn_id == turn_id:
            self.active_turn_id = None

    def next_event(self, kind: str, turn_id: str | None, payload: dict) -> dict:
        self.last_seq += 1
        return ServerEvent(type=kind, turn_id=turn_id, seq=self.last_seq,
                           payload=redact(payload)).model_dump()

    def summary(self) -> dict:
        pending = self.pending_confirmation
        return redact({"session_id": self.session_id, "last_seq": self.last_seq,
            "last_turn_id": self.last_turn_id, "active_scenario": self.active_scenario,
            "pending_confirmation": {k: pending[k] for k in ("name", "summary") if k in pending} if pending else None,
            "last_trace": self.last_trace})


class SessionManager:
    def __init__(self, catalog, processor):
        self.catalog = catalog
        self.processor = processor
        self._sessions: dict[str, Session] = {}

    def create(self) -> Session:
        session = Session(str(uuid4()), deepcopy(self.catalog.mock_backend))
        self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    async def process_text(self, session_id: str, turn_id: str, text: str):
        session = self.get(session_id)
        if session is None:
            raise TurnRejected("session_not_found")
        session.claim(turn_id)
        try:
            return await self.process_claimed(session, turn_id, text)
        finally:
            session.release(turn_id)

    async def process_claimed(self, session: Session, turn_id: str, text: str):
        """Process a turn admitted by the WS receiver; never call for a replay."""
        result = await self.processor(session.session_id, turn_id, text)
        data = result.model_dump() if hasattr(result, "model_dump") else result
        session.results[turn_id] = data
        scenarios = data["route"]["scenarios"]
        session.active_scenario = scenarios[0]["scenario_id"] if scenarios else None
        session.pending_confirmation = data.get("pending_confirmation")
        return data
