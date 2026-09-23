"""Real WebSocket admission/ordering with deterministic external voice providers."""

import asyncio
import json
import threading

import pytest

from fastapi.testclient import TestClient

from app.main import create_app
from test_api import Processor, create_session, read_turn, send_text


class Transcriber:
    def __init__(self, *, on_partial):
        self.on_partial = on_partial
        self.closed = False

    async def feed(self, pcm):
        await self.on_partial("Промежуточный текст")

    async def finish(self):
        return "Где офис?"

    async def aclose(self):
        self.closed = True


class Synthesizer:
    def __init__(self, *, fail=False, gated=False):
        self.fail = fail
        self.gated = gated
        self.resume = threading.Event()
        self.texts = []

    async def stream(self, text, language):
        self.texts.append((text, language))
        if self.fail:
            raise RuntimeError("upstream secret test@example.com")
        yield b"\x00\x00" * 3
        if self.gated:
            async with asyncio.timeout(3):
                while not self.resume.is_set():
                    await asyncio.sleep(0.001)
        yield b"\x01\x00" * 3


def start(ws, turn_id="audio-1"):
    ws.send_json({"type": "turn.start", "turn_id": turn_id, "payload": {"mode": "audio"}})


def commit(ws, turn_id="audio-1"):
    ws.send_json({"type": "turn.commit", "turn_id": turn_id, "payload": {}})


def read_mixed_turn(ws):
    result = []
    while True:
        frame = ws.receive()
        item = json.loads(frame["text"]) if "text" in frame else frame["bytes"]
        result.append(item)
        if isinstance(item, dict) and item["type"] == "turn.complete":
            return result


def test_audio_commit_is_only_graph_boundary_and_pcm_is_framed():
    processor, synth = Processor(), Synthesizer()
    with TestClient(create_app(processor=processor, transcriber_factory=Transcriber, synthesizer=synth)) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            start(ws)
            ws.send_bytes(b"\0\0" * 2400)
            assert ws.receive_json()["type"] == "transcript.partial"
            assert processor.calls == []
            commit(ws)
            frames = read_mixed_turn(ws)
            assert [f["type"] if isinstance(f, dict) else "pcm" for f in frames] == [
                "transcript.final", "route.decision", "agent.text", "audio.start", "pcm", "pcm",
                "audio.end", "trace.updated", "turn.complete"]
            assert len(processor.calls) == 1
            assert processor.calls[0][2] == "Где офис?"
            assert "test@example.com" not in synth.texts[0][0]
            trace = frames[-2]["payload"]
            assert trace["latency_ms"]["stt"] >= 0
            assert trace["latency_ms"]["tts_first_audio"] >= 0
            assert trace["latency_ms"]["server_first_audio"] >= trace["latency_ms"]["tts_first_audio"]


def test_tts_failure_preserves_answer_and_duplicate_never_reroutes():
    processor = Processor()
    with TestClient(create_app(processor=processor, transcriber_factory=Transcriber,
                              synthesizer=Synthesizer(fail=True))) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            start(ws)
            ws.send_bytes(b"\0\0")
            ws.receive_json()
            commit(ws)
            events = read_turn(ws)
            assert any(e["type"] == "agent.text" for e in events)
            assert any(e["type"] == "error" and e["payload"]["code"] == "tts_unavailable" for e in events)
            assert events[-1]["payload"]["status"] == "answered"
            assert "secret" not in json.dumps(events)
            start(ws)
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            assert len(processor.calls) == 1


def test_empty_tts_stream_reports_unavailable_and_keeps_text():
    class EmptySynthesizer:
        async def stream(self, text, language):
            if False:
                yield b""

    with TestClient(create_app(processor=Processor(), synthesizer=EmptySynthesizer())) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws)
            events = read_turn(ws)
            assert "agent.text" in [event["type"] for event in events]
            assert any(event["type"] == "error" and event["payload"]["code"] == "tts_unavailable"
                       for event in events)
            assert "audio.start" not in [event["type"] for event in events]
            assert events[-1]["payload"]["status"] == "answered"


def test_playback_ack_is_read_while_tts_waits_and_updates_client_metric():
    synth = Synthesizer(gated=True)
    with TestClient(create_app(processor=Processor(), synthesizer=synth)) as client:
        session = create_session(client)
        with client.websocket_connect(session["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws)
            for kind in ("transcript.final", "route.decision", "agent.text", "audio.start"):
                assert ws.receive_json()["type"] == kind
            assert ws.receive_bytes() == b"\0\0" * 3
            ws.send_json({"type": "playback.started", "turn_id": "turn-1", "payload": {"latency_ms": 1410}})
            trace = ws.receive_json()
            assert trace["type"] == "trace.updated"
            assert trace["payload"]["client_first_audio_ms"] == 1410
            synth.resume.set()
            frames = read_mixed_turn(ws)
            assert frames[-2]["payload"]["client_first_audio_ms"] == 1410
        summary = client.get(f'/api/v1/sessions/{session["session_id"]}').json()
        assert summary["last_trace"]["client_first_audio_ms"] == 1410


def test_binary_admission_active_turn_and_disconnect_cleanup():
    processor = Processor()
    transcribers = []

    def factory(**kwargs):
        instance = Transcriber(**kwargs)
        transcribers.append(instance)
        return instance

    with TestClient(create_app(processor=processor, transcriber_factory=factory, synthesizer=None)) as client:
        session = create_session(client)
        with client.websocket_connect(session["ws_path"]) as ws:
            ws.receive_json()
            ws.send_bytes(b"\0\0")
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            start(ws)
            start(ws, "second")
            assert ws.receive_json()["payload"]["code"] == "busy"
            commit(ws, "wrong")
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            ws.send_bytes(b"\0")
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            ws.send_bytes(b"\0\0")
            assert ws.receive_json()["type"] == "transcript.partial"
            assert processor.calls == []
        assert transcribers[0].closed
        with client.websocket_connect(session["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws, "new")
            assert read_turn(ws)[-1]["payload"]["status"] == "answered"


def test_inflight_duplicate_cannot_call_graph_twice():
    synth, processor = Synthesizer(gated=True), Processor()
    with TestClient(create_app(processor=processor, synthesizer=synth)) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            send_text(ws)
            for _ in range(4):
                ws.receive_json()
            ws.receive_bytes()
            send_text(ws)
            assert ws.receive_json()["payload"]["code"] == "invalid_event"
            send_text(ws, "second")
            assert ws.receive_json()["payload"]["code"] == "busy"
            assert len(processor.calls) == 1
            synth.resume.set()
            read_mixed_turn(ws)


@pytest.mark.parametrize("fail_at", ["feed", "finish"])
def test_stt_failure_even_with_cleanup_failure_leaves_text_fallback_usable(fail_at):
    class FailingSTT(Transcriber):
        async def feed(self, pcm):
            if fail_at == "feed":
                raise RuntimeError("provider failure")
            await super().feed(pcm)

        async def finish(self):
            raise RuntimeError("provider failure")

        async def aclose(self):
            raise RuntimeError("provider cleanup failed")

    processor = Processor()
    with TestClient(create_app(processor=processor, transcriber_factory=FailingSTT, synthesizer=None)) as client:
        with client.websocket_connect(create_session(client)["ws_path"]) as ws:
            ws.receive_json()
            start(ws)
            ws.send_bytes(b"\0\0")
            if fail_at == "finish":
                assert ws.receive_json()["type"] == "transcript.partial"
                commit(ws)
            events = read_turn(ws)
            assert events[0]["payload"]["code"] == "stt_unavailable"
            assert events[-1]["payload"]["status"] == "error"
            send_text(ws, "fallback")
            assert read_turn(ws)[-1]["payload"]["status"] == "answered"
            assert [call[1] for call in processor.calls] == ["fallback"]
