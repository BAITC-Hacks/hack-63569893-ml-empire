"""HTTP/WS contract tests; external graph and voice providers are injected."""

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app


class Processor:
    def __init__(self):
        self.calls = []
        self.status = "completed"

    async def __call__(self, session_id, turn_id, text):
        self.calls.append((session_id, turn_id, text))
        return {
            "session_id": session_id, "turn_id": turn_id,
            "text": "Ответ +7 (777) 123-45-67, 123456789012, test@example.com",
            "language": "ru", "status": self.status,
            "route": {"scenarios": [{"scenario_id": "SC01", "reason": text,
                       "confidence_estimate": 0.9}], "alternatives": [], "slots": {},
                      "language": "ru", "source": "llm", "is_continuation": False,
                      "needs_clarification": False},
            "actions": [], "trace": [], "pending_scenarios": [],
            "pending_confirmation": None, "timings": {"router": 1.0},
        }


@pytest.fixture
def processor():
    return Processor()


@pytest.fixture
def client(processor):
    with TestClient(create_app(processor=processor, synthesizer=None)) as client:
        yield client


def create_session(client):
    response = client.post("/api/v1/sessions", json={})
    assert response.status_code == 200
    return response.json()


def read_turn(ws):
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        if event["type"] == "turn.complete":
            return events


def send_text(ws, turn_id="turn-1", text="Где офис?"):
    ws.send_json({"type": "turn.text", "turn_id": turn_id, "payload": {"text": text}})


def test_http_contract_and_reconnect_summary(client):
    assert client.get("/api/v1/health").json() == {"status": "ok"}
    session = create_session(client)
    assert session["audio_input"] == session["audio_output"] == {
        "encoding": "pcm_s16le", "sample_rate_hz": 24000, "channels": 1,
    }
    assert session["as_of_date"] == "2026-10-01"
    summary = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
    assert summary == {"session_id": session["session_id"], "last_seq": 0,
                       "last_turn_id": None, "active_scenario": None,
                       "pending_confirmation": None, "last_trace": None}
    rows = client.get("/api/v1/catalog/scenarios").json()
    assert len(rows) == 40
    assert set(rows[0]) == {"scenario_id", "name", "priority"}
    assert client.get("/api/v1/sessions/missing").status_code == 404
    assert "/api/v1/sessions" in client.get("/openapi.json").json()["paths"]


def test_text_events_are_ordered_redacted_and_duplicate_is_not_reexecuted(client, processor):
    session = create_session(client)
    with client.websocket_connect(session["ws_path"]) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "session.ready"
        assert ready["turn_id"] is None
        send_text(ws, text="+7 (777) 123-45-67, 123456789012, test@example.com")
        events = read_turn(ws)
        assert [e["type"] for e in events] == ["transcript.final", "route.decision",
                                                "agent.text", "trace.updated", "turn.complete"]
        assert events[-1]["payload"]["status"] == "answered"
        assert events[1]["payload"]["reason"]
        seqs = [ready["seq"]] + [e["seq"] for e in events]
        assert seqs == sorted(set(seqs))
        serialized = json.dumps(events)
        for pii in ["777", "123456789012", "test@example.com"]:
            assert pii not in serialized
        send_text(ws)
        assert ws.receive_json()["payload"]["code"] == "invalid_event"
        assert len(processor.calls) == 1
    summary = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
    assert summary["last_turn_id"] == "turn-1"
    assert summary["active_scenario"] == "SC01"
    assert summary["last_trace"]["latency_ms"]["stt"] == 0
    with client.websocket_connect(session["ws_path"]) as ws:
        assert ws.receive_json()["seq"] > seqs[-1]


@pytest.mark.parametrize("status,expected", [("collecting_slots", "clarify"),
    ("awaiting_confirmation", "clarify"), ("clarifying", "clarify"), ("handoff", "handoff")])
def test_internal_status_maps_to_frontend(client, processor, status, expected):
    processor.status = status
    with client.websocket_connect(create_session(client)["ws_path"]) as ws:
        ws.receive_json()
        send_text(ws)
        assert read_turn(ws)[-1]["payload"]["status"] == expected


def test_missing_session_and_untrusted_origin_are_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/sessions/missing/stream"):
            pass
    path = create_session(client)["ws_path"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers={"origin": "https://evil.example"}):
            pass
    headers = {"origin": "http://localhost:5173", "access-control-request-method": "POST"}
    assert client.options("/api/v1/sessions", headers=headers).headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in client.get("/api/v1/health", headers={"origin": "https://evil.example"}).headers


@pytest.mark.parametrize("message", ["not-json", "[]", '{}',
    '{"type":"turn.text","payload":{"text":"hi"}}',
    '{"type":"turn.text","turn_id":"x","payload":{"text":" "}}'])
def test_malformed_events_return_recoverable_error(client, processor, message):
    with client.websocket_connect(create_session(client)["ws_path"]) as ws:
        ws.receive_json()
        ws.send_text(message)
        error = ws.receive_json()
        assert error["type"] == "error"
        assert error["payload"]["code"] == "invalid_event"
        send_text(ws)
        assert read_turn(ws)[-1]["payload"]["status"] == "answered"
        assert len(processor.calls) == 1


def test_confirmation_preview_and_restored_summary_are_safe():
    async def preview(session_id, turn_id, text):
        result = await Processor()(session_id, turn_id, text)
        result["status"] = "awaiting_confirmation"
        result["pending_confirmation"] = {"name": "create_claim", "summary": "Для 123456789012",
            "action_id": "secret-id", "inputs": {"iin": "123456789012"}}
        result["actions"] = [{"name": "create_claim", "inputs": {"iin": "123456789012"},
                              "result": {}, "status": "preview"}]
        return result

    with TestClient(create_app(processor=preview, synthesizer=None)) as client:
        session = create_session(client)
        with client.websocket_connect(session["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws)
            events = read_turn(ws)
            preview_event = events[2]
            assert preview_event["type"] == "action.preview"
            assert preview_event["payload"]["masked_args"]["iin"] != "123456789012"
            assert events[-1]["payload"]["status"] == "clarify"
        summary = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
        assert set(summary["pending_confirmation"]) == {"name", "summary"}
        assert "123456789012" not in json.dumps(summary)


def test_router_failure_is_recoverable_without_reexecuting_failed_turn():
    calls = []

    async def fail_once(session_id, turn_id, text):
        calls.append(turn_id)
        if turn_id == "broken":
            raise RuntimeError("test@example.com")
        return await Processor()(session_id, turn_id, text)

    with TestClient(create_app(processor=fail_once, synthesizer=None)) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws, "broken")
            events = read_turn(ws)
            assert [e["type"] for e in events] == ["transcript.final", "route.decision",
                "agent.text", "trace.updated", "error", "turn.complete"]
            route = events[1]["payload"]
            assert route["scenarios"][0]["scenario_id"] == "SYS_UNCLEAR"
            assert route["source"] == "llm"
            assert events[2]["payload"]["text"]
            assert events[3]["payload"]["actions"] == []
            assert events[-2]["payload"]["code"] == "router_unavailable"
            assert events[-1]["payload"]["status"] == "error"
            assert "test@example.com" not in json.dumps(events)
            send_text(ws, "broken")
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            send_text(ws, "new")
            assert read_turn(ws)[-1]["payload"]["status"] == "answered"
        assert calls == ["broken", "new"]


def test_default_app_health_does_not_require_provider_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/health").json() == {"status": "ok"}
        assert create_session(client)["session_id"]


def test_settings_accept_environment_data_directory_and_router_model(monkeypatch, tmp_path):
    from app.config import DEFAULT_DATA_DIR, REQUIRED_DATA_FILES, Settings

    for name in REQUIRED_DATA_FILES:
        (tmp_path / name).write_bytes((DEFAULT_DATA_DIR / name).read_bytes())
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ROUTER_MODEL", "test-model")
    settings = Settings()
    assert settings.data_dir == tmp_path
    assert settings.router_model == "test-model"


def test_huge_playback_latency_is_rejected(client):
    with client.websocket_connect(create_session(client)["ws_path"]) as ws:
        ws.receive_json()
        ws.send_json({"type": "playback.started", "turn_id": "x",
                      "payload": {"latency_ms": 10 ** 400}})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert error["payload"]["code"] == "invalid_event"


def test_graph_timings_are_mapped_to_frontend_names():
    async def graph_shaped(session_id, turn_id, text):
        result = await Processor()(session_id, turn_id, text)
        result["timings"] = {"route_ms": 12.5, "total_ms": 20}
        result["route"]["routing_error"] = "provider_error"
        return result

    with TestClient(create_app(processor=graph_shaped, synthesizer=None)) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws)
            events = read_turn(ws)
            trace = next(e["payload"] for e in events if e["type"] == "trace.updated")
            assert trace["latency_ms"]["router"] == 12.5
            assert any(e["type"] == "error" and e["payload"]["code"] == "router_unavailable" for e in events)


def test_turn_logging_uses_identifiers_without_raw_personal_data(client, caplog):
    with caplog.at_level("INFO", logger="app.api.ws"):
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws, "logged-turn", "test@example.com 123456789012")
            read_turn(ws)
    assert "logged-turn" in caplog.text
    assert "test@example.com" not in caplog.text
    assert "123456789012" not in caplog.text
