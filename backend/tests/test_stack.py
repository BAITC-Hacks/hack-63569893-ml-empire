"""Exercise the default API composition, replacing only the external LLM call."""

import json

from fastapi.testclient import TestClient

from app.main import create_app
from app.router import LLMRouter, RouterDecision, SelectedScenario


def receive_turn(ws):
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        if event["type"] == "turn.complete":
            return events


def send_turn(ws, turn_id, text):
    ws.send_json({"type": "turn.text", "turn_id": turn_id, "payload": {"text": text}})
    return receive_turn(ws)


def test_default_stack_confirms_once_and_restores_session(monkeypatch):
    async def route(self, text, context):
        return RouterDecision(
            language="ru", scenarios=[SelectedScenario(scenario_id="SC28",
                reason="Отмена по просьбе клиента", confidence_estimate=None)],
            alternatives=[], slots={"policy_number": "SQ-OGPO-104501", "cancel_reason": "Sold vehicle"},
            is_continuation=False, needs_clarification=False,
        )

    monkeypatch.setattr(LLMRouter, "route", route)
    with TestClient(create_app(synthesizer=None)) as client:
        session = client.post("/api/v1/sessions", json={}).json()
        with client.websocket_connect(session["ws_path"]) as ws:
            ready = ws.receive_json()
            first = send_turn(ws, "preview", "Хочу расторгнуть полис, телефон +77010000001")
            assert any(e["type"] == "action.preview" for e in first)
            assert first[-1]["payload"]["status"] == "clarify"
            before = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
            assert before["pending_confirmation"]["name"] == "cancel_policy"
            second = send_turn(ws, "confirm", "Да, подтверждаю")
            route_event = next(e for e in second if e["type"] == "route.decision")
            assert route_event["payload"]["source"] == "confirmation"
            trace = next(e["payload"] for e in second if e["type"] == "trace.updated")
            cancellation = [a for a in trace["actions"] if a["name"] == "cancel_policy"]
            assert len(cancellation) == 1
            assert cancellation[0]["status"] == "completed"
            assert "refund_amount" in cancellation[0]["result"]
            assert second[-1]["payload"]["status"] == "answered"
            ws.send_json({"type": "turn.text", "turn_id": "confirm", "payload": {"text": "Да"}})
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            assert "+77010000001" not in json.dumps(first + second)
            assert all("104501" not in e["payload"]["text"] for e in first + second
                       if e["type"] == "agent.text")
            sequences = [e["seq"] for e in [ready, *first, *second]]
            assert sequences == sorted(set(sequences))
        restored = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
        assert restored["pending_confirmation"] is None
        assert restored["last_turn_id"] == "confirm"
        assert restored["last_trace"]["actions"] == trace["actions"]


def test_missing_key_is_reported_through_real_router_graph_and_ws(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app(synthesizer=None)) as client:
        session = client.post("/api/v1/sessions", json={}).json()
        with client.websocket_connect(session["ws_path"]) as ws:
            ws.receive_json()
            events = send_turn(ws, "no-key", "Где ваш офис?")
            assert any(e["type"] == "route.decision" for e in events)
            assert any(e["type"] == "agent.text" for e in events)
            assert any(e["type"] == "error" and e["payload"]["code"] == "router_unavailable" for e in events)
            assert events[-1]["payload"]["status"] == "clarify"
