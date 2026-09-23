"""Check a running backend over real HTTP and WebSocket connections.

Start the target server with OPENAI_API_KEY empty for a provider-free smoke test.
The identity question bypasses the LLM, but a server with a key will attempt TTS.
This script never reads .env or configures the target server's environment.

Usage: uv run --project backend python backend/scripts/smoke_container.py \
    --base-url http://127.0.0.1:18080
"""

import argparse
import asyncio
import json
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect


AUDIO_FORMAT = {"encoding": "pcm_s16le", "sample_rate_hz": 24000, "channels": 1}
TURN_ID = "docker-smoke-identity"
QUESTION = "Вы робот?"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request_json(base_url, path, *, method="GET"):
    request = Request(
        base_url + path,
        data=b"{}" if method == "POST" else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urlopen(request, timeout=5) as response:
        require(response.status == 200, "HTTP endpoint did not return 200")
        return json.load(response)


async def check_websocket(url, session_id):
    last_seq = 0

    async def receive(ws, *, turn_id):
        nonlocal last_seq
        frame = await ws.recv()
        require(isinstance(frame, str), "Unexpected audio: run the server without a provider key")
        event = json.loads(frame)
        require(isinstance(event, dict), "Invalid WebSocket envelope")
        require(event.get("seq") == last_seq + 1, "WebSocket sequence is not contiguous")
        require(event.get("turn_id") == turn_id, "WebSocket turn_id mismatch")
        require(isinstance(event.get("payload"), dict), "Missing WebSocket payload")
        last_seq = event["seq"]
        return event

    async with asyncio.timeout(20):
        async with connect(url, open_timeout=5, close_timeout=2) as ws:
            ready = await receive(ws, turn_id=None)
            require(ready.get("type") == "session.ready", "Missing session.ready")
            require(ready["payload"].get("session_id") == session_id, "Wrong ready session")
            turn = {"type": "turn.text", "turn_id": TURN_ID, "payload": {"text": QUESTION}}
            await ws.send(json.dumps(turn, ensure_ascii=False))
            events = []
            while True:
                event = await receive(ws, turn_id=TURN_ID)
                events.append(event)
                require(len(events) <= 16, "Unexpected number of turn events")
                if event.get("type") == "turn.complete":
                    break

            errors = [event for event in events if event["type"] == "error"]
            require(all(event["payload"].get("code") == "tts_unavailable" for event in errors),
                    "Turn contains an unexpected backend error")
            require(len(errors) <= 1, "Duplicate TTS error")
            normal = [event for event in events if event["type"] != "error"]
            require([event["type"] for event in normal] == [
                "transcript.final", "route.decision", "agent.text", "trace.updated", "turn.complete",
            ], "Turn event order or types differ from the frontend contract")
            require(normal[0]["payload"].get("text") == QUESTION, "Transcript differs from text input")
            require(normal[1]["payload"].get("source") == "continuation", "Identity turn reached LLM routing")
            answer = normal[2]["payload"].get("text")
            require(isinstance(answer, str) and bool(answer.strip()), "Empty identity answer")
            require(normal[3]["payload"].get("actions") == [], "Identity turn executed a business action")
            require(normal[4]["payload"].get("status") == "answered", "Identity turn was not answered")

            await ws.send(json.dumps(turn, ensure_ascii=False))
            duplicate = await receive(ws, turn_id=TURN_ID)
            require(duplicate.get("type") == "error" and duplicate["payload"].get("code") == "invalid_event",
                    "Duplicate turn was not rejected")

    return last_seq, len(events), bool(errors)


def smoke(base_url):
    require(request_json(base_url, "/api/v1/health") == {"status": "ok"}, "Health check failed")
    catalog = request_json(base_url, "/api/v1/catalog/scenarios")
    require(isinstance(catalog, list) and len(catalog) == 40, "Catalog must contain 40 scenarios")
    require(all(isinstance(row, dict) and set(row) == {"scenario_id", "name", "priority"}
                for row in catalog), "Invalid catalog response")
    require(len({row["scenario_id"] for row in catalog}) == 40, "Catalog scenario IDs are not unique")
    session = request_json(base_url, "/api/v1/sessions", method="POST")
    session_id = session.get("session_id")
    require(isinstance(session_id, str) and bool(session_id), "Missing session_id")
    path = f"/api/v1/sessions/{session_id}"
    require(session.get("ws_path") == path + "/stream", "Wrong session WebSocket path")
    require(session.get("audio_input") == session.get("audio_output") == AUDIO_FORMAT, "Wrong audio format")
    require(session.get("as_of_date") == "2026-10-01", "Wrong synthetic catalog date")
    initial = request_json(base_url, path)
    require(initial.get("last_seq") == 0 and initial.get("last_turn_id") is None, "Session is not fresh")

    parsed = urlsplit(base_url)
    ws_url = urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc,
                        session["ws_path"], "", ""))
    last_seq, event_count, tts_unavailable = asyncio.run(check_websocket(ws_url, session_id))
    restored = request_json(base_url, path)
    require(restored.get("session_id") == session_id, "Restored session ID differs")
    require(restored.get("last_turn_id") == TURN_ID and restored.get("last_seq") == last_seq,
            "Session summary did not preserve the completed turn")
    require(isinstance(restored.get("last_trace"), dict), "Session summary lost the trace")
    print(f"PASS: health, 40 scenarios, session, WebSocket identity ({event_count} events), "
          f"duplicate rejection, restored summary; tts_unavailable={tts_unavailable}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    parsed = urlsplit(base_url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path
            or parsed.query or parsed.fragment or parsed.username or parsed.password):
        parser.error("--base-url must be an HTTP(S) origin without credentials, path, query or fragment")
    try:
        smoke(base_url)
    except Exception as exc:
        # Never echo provider errors or response bodies, which could contain secrets.
        detail = str(exc) if type(exc) is RuntimeError else type(exc).__name__
        print(f"FAIL: {detail}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
