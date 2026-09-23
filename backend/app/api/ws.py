"""Ordered WebSocket events with independent receive, turn, and write tasks."""

import asyncio
from contextlib import suppress
from copy import deepcopy
import logging
from time import perf_counter

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.api.contracts import AUDIO_FORMAT, ClientEvent, frontend_status, redact
from app.sessions import TurnRejected


router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket("/api/v1/sessions/{session_id}/stream")
async def stream(websocket: WebSocket, session_id: str):
    manager = websocket.app.state.sessions
    session = manager.get(session_id)
    origin = websocket.headers.get("origin")
    if session is None or (origin and origin != websocket.app.state.settings.frontend_origin):
        await websocket.close(code=1008)
        return
    if session.connected:
        await websocket.close(code=1008)
        return
    session.connected = True
    await websocket.accept()
    outgoing = asyncio.Queue()
    worker = None
    recording = None
    recording_turn = None
    traces = {}
    audio_turn = None
    receiver = asyncio.current_task()

    def emit(kind, turn_id, payload):
        outgoing.put_nowait((kind, turn_id, deepcopy(payload), None))

    def error(turn_id, code):
        emit("error", turn_id, {"code": code, "message": code.replace("_", " "), "recoverable": True})

    async def close_transcriber(transcriber):
        # Provider cleanup cannot prevent releasing a call for text fallback.
        with suppress(Exception):
            async with asyncio.timeout(2):
                await transcriber.aclose()

    async def write():
        sent = None
        try:
            while True:
                kind, turn_id, payload, sent = await outgoing.get()
                if kind == "pcm":
                    await websocket.send_bytes(payload)
                    if not sent.done():
                        sent.set_result(perf_counter())
                else:
                    await websocket.send_json(session.next_event(kind, turn_id, payload))
                sent = None
        except asyncio.CancelledError:
            raise
        except Exception:
            if sent is not None and not sent.done():
                sent.cancel()
            logger.warning("WebSocket writer failed session_id=%s", session_id)
            receiver.cancel()

    def update_trace(turn_id):
        trace = traces[turn_id]
        if session.last_turn_id == turn_id:
            session.last_trace = redact(deepcopy(trace))
        emit("trace.updated", turn_id, trace)

    async def audio_reply(turn_id, result, start):
        nonlocal audio_turn
        synth = websocket.app.state.synthesizer
        if synth is None:
            return
        began = False
        first = True
        tts_start = perf_counter()
        try:
            async with asyncio.timeout(35):
                async for chunk in synth.stream(redact(result["text"]), result["language"]):
                    if not chunk:
                        continue
                    if not isinstance(chunk, bytes) or len(chunk) % 2:
                        raise ValueError("Invalid PCM output")
                    if not began:
                        audio_turn = turn_id
                        began = True
                        emit("audio.start", turn_id, AUDIO_FORMAT)
                    sent = asyncio.get_running_loop().create_future()
                    outgoing.put_nowait(("pcm", turn_id, chunk, sent))
                    sent_at = await sent
                    if first:
                        traces[turn_id]["latency_ms"].update({
                            "tts_first_audio": (sent_at - tts_start) * 1000,
                            "server_first_audio": (sent_at - start) * 1000,
                        })
                        first = False
            if not began:
                error(turn_id, "tts_unavailable")
        except Exception:
            error(turn_id, "tts_unavailable")
        finally:
            if began:
                emit("audio.end", turn_id, {})

    async def process(turn_id, text=None, transcriber=None):
        start = perf_counter()
        final_sent = False
        route_sent = False
        agent_sent = False
        trace_sent = False
        logger.info("turn started turn_id=%s session_id=%s", turn_id, session_id)
        try:
            stt_ms = 0.0
            if transcriber is not None:
                try:
                    async with asyncio.timeout(25):
                        text = await transcriber.finish()
                    if not isinstance(text, str) or not text.strip():
                        raise ValueError("Empty transcript")
                    stt_ms = (perf_counter() - start) * 1000
                except Exception:
                    error(turn_id, "stt_unavailable")
                    emit("turn.complete", turn_id, {"status": "error"})
                    return
            emit("transcript.final", turn_id, {"text": text, "language": None})
            final_sent = True
            async with asyncio.timeout(60):
                result = await manager.process_claimed(session, turn_id, text)
            route = dict(result["route"])
            route.setdefault("reason", "; ".join(row["reason"] for row in route["scenarios"]))
            emit("route.decision", turn_id, route)
            route_sent = True
            if route.get("routing_error") or any(step.get("routing_error") for step in result["trace"]):
                error(turn_id, "router_unavailable")
            for action in result["actions"]:
                if action["status"] == "preview":
                    pending = result.get("pending_confirmation") or {}
                    emit("action.preview", turn_id, {"name": action["name"],
                         "summary": pending.get("summary", action["name"]), "masked_args": action["inputs"]})
                elif action["status"] == "error":
                    error(turn_id, "action_failed")
            emit("agent.text", turn_id, {"text": result["text"], "language": result["language"]})
            agent_sent = True
            timings = {key.removesuffix("_ms"): value for key, value in result["timings"].items()}
            if "route" in timings:
                timings["router"] = timings.pop("route")
            traces[turn_id] = {"actions": result["actions"], "steps": result["trace"],
                     "latency_ms": {**timings, "stt": stt_ms},
                     "handoff": route if result["status"] == "handoff" else None}
            await audio_reply(turn_id, result, start)
            traces[turn_id]["latency_ms"]["total"] = (perf_counter() - start) * 1000
            update_trace(turn_id)
            trace_sent = True
            emit("turn.complete", turn_id, {"status": frontend_status(result["status"])})
        except Exception:
            if final_sent:
                if not route_sent:
                    emit("route.decision", turn_id, {"scenarios": [{"scenario_id": "SYS_UNCLEAR",
                         "reason": "Маршрутизация временно недоступна", "confidence_estimate": None}],
                         "alternatives": [], "slots": {}, "language": "ru", "source": "llm",
                         "reason": "Маршрутизация временно недоступна",
                         "is_continuation": False, "needs_clarification": True})
                if not agent_sent:
                    emit("agent.text", turn_id, {"text": "Не удалось обработать запрос. Попробуйте ещё раз.",
                                                  "language": "ru"})
                if not trace_sent:
                    traces[turn_id] = {"actions": [], "steps": [],
                        "latency_ms": {"stt": stt_ms, "total": (perf_counter() - start) * 1000},
                        "handoff": None}
                    update_trace(turn_id)
            error(turn_id, "router_unavailable")
            emit("turn.complete", turn_id, {"status": "error"})
        finally:
            logger.info("turn finished turn_id=%s session_id=%s", turn_id, session_id)
            session.release(turn_id)
            if transcriber is not None:
                await close_transcriber(transcriber)

    writer = asyncio.create_task(write())
    emit("session.ready", None, {"session_id": session_id, "last_seq": session.last_seq})
    try:
        while True:
            frame = await websocket.receive()
            if frame["type"] == "websocket.disconnect":
                break
            if frame.get("bytes") is not None:
                pcm = frame["bytes"]
                if recording is None or len(pcm) % 2 or len(pcm) > 1024 * 1024:
                    error(recording_turn, "invalid_event")
                    continue
                try:
                    async with asyncio.timeout(25):
                        await recording.feed(pcm)
                except Exception:
                    error(recording_turn, "stt_unavailable")
                    emit("turn.complete", recording_turn, {"status": "error"})
                    session.release(recording_turn)
                    await close_transcriber(recording)
                    recording, recording_turn = None, None
                continue
            try:
                event = ClientEvent.model_validate_json(frame.get("text", ""))
            except (ValidationError, ValueError, TypeError):
                error(None, "invalid_event")
                continue
            if event.type == "playback.started":
                turn_id = event.turn_id or audio_turn
                if turn_id != audio_turn or turn_id not in traces:
                    error(event.turn_id, "invalid_event")
                    continue
                traces[turn_id].setdefault("client_first_audio_ms", event.payload["latency_ms"])
                update_trace(turn_id)
                continue
            if event.type == "turn.commit":
                if recording is None or recording_turn != event.turn_id:
                    error(event.turn_id, "invalid_event")
                    continue
                worker = asyncio.create_task(process(event.turn_id, transcriber=recording))
                recording, recording_turn = None, None
                continue
            try:
                session.claim(event.turn_id)
            except TurnRejected as exc:
                error(event.turn_id, exc.code)
                continue
            if event.type == "turn.text":
                worker = asyncio.create_task(process(event.turn_id, event.payload["text"]))
            else:
                turn_id = event.turn_id

                async def on_partial(text, current_turn=turn_id):
                    if recording_turn == current_turn:
                        emit("transcript.partial", current_turn, {"text": text})

                try:
                    recording = websocket.app.state.transcriber_factory(on_partial=on_partial)
                    recording_turn = turn_id
                except Exception:
                    session.release(turn_id)
                    error(turn_id, "stt_unavailable")
                    emit("turn.complete", turn_id, {"status": "error"})
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        if not writer.done():
            raise
    finally:
        for task in (worker, writer):
            if task is not None:
                task.cancel()
        await asyncio.gather(*(t for t in (worker, writer) if t is not None), return_exceptions=True)
        if recording is not None:
            session.release(recording_turn)
            await close_transcriber(recording)
        session.connected = False
