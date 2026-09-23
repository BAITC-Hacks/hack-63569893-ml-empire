"""One-turn OpenAI Realtime transcription adapter for PCM16 mono 24 kHz.

Each instance owns one upstream transcription session and one committed item.
See https://developers.openai.com/api/docs/guides/realtime-transcription.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
from collections.abc import AsyncIterator, Callable
from typing import Any


_END = object()


class Transcriber:
    def __init__(
        self,
        *,
        connector: Callable[..., Any] | None = None,
        api_key: str | None = None,
        model: str = "gpt-live-transcribe",
        timeout: float = 20.0,
        on_partial: Callable[[str], Any] | None = None,
    ) -> None:
        self._connector = connector
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._on_partial = on_partial
        self._socket: Any = None
        self._reader_task: asyncio.Task[None] | None = None
        self._callback_task: asyncio.Task[None] | None = None
        self._callback_queue: asyncio.Queue[str] = asyncio.Queue()
        self._callback_stop = False
        self._final: asyncio.Future[str] | None = None
        self._committed_id: str | None = None
        self._completed: dict[str, str] = {}
        self._partials: dict[str, str] = {}
        self._partial_queue: asyncio.Queue[str | object] = asyncio.Queue()
        self._finished = False

    async def _connect(self) -> None:
        if self._socket is not None:
            return
        api_key = self._api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for live transcription")
        if self._connector is None:
            from websockets.asyncio.client import connect

            connector = connect
        else:
            connector = self._connector
        self._socket = await asyncio.wait_for(
            connector(
                f"wss://api.openai.com/v1/realtime?model={self._model}",
                additional_headers={"Authorization": f"Bearer {api_key}"},
            ),
            timeout=self._timeout,
        )
        self._final = asyncio.get_running_loop().create_future()
        self._reader_task = asyncio.create_task(self._read_events())
        if self._on_partial is not None:
            self._callback_stop = False
            self._callback_task = asyncio.create_task(self._run_callbacks())
        try:
            await self._send(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": {"type": "audio/pcm", "rate": 24000},
                                "transcription": {"model": self._model},
                                "turn_detection": None,
                            }
                        },
                    },
                }
            )
        except BaseException:
            await self.aclose()
            self._final = None
            self._partial_queue = asyncio.Queue()
            self._callback_queue = asyncio.Queue()
            raise

    async def _send(self, event: dict[str, Any]) -> None:
        await asyncio.wait_for(self._socket.send(json.dumps(event)), timeout=self._timeout)

    async def feed(self, pcm: bytes) -> None:
        """Append complete little-endian PCM16 samples to this turn."""
        if self._finished:
            raise RuntimeError("transcription turn has already been committed")
        if not isinstance(pcm, bytes) or len(pcm) % 2:
            raise ValueError("PCM16 input must contain complete two-byte samples")
        if not pcm:
            return
        await self._connect()
        try:
            await self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode("ascii")})
        except BaseException:
            await self.aclose()
            raise

    async def finish(self) -> str:
        """Commit this turn and wait for its matching final transcript."""
        if self._finished:
            raise RuntimeError("transcription turn has already been committed")
        if self._socket is None:
            raise ValueError("cannot transcribe an empty audio turn")
        self._finished = True
        try:
            await self._send({"type": "input_audio_buffer.commit"})
            assert self._final is not None
            return await asyncio.wait_for(self._final, timeout=self._timeout)
        finally:
            await self.aclose()

    async def partials(self) -> AsyncIterator[str]:
        """Yield cumulative partial text until the upstream session closes."""
        while True:
            value = await self._partial_queue.get()
            if value is _END:
                return
            yield value  # type: ignore[misc]

    async def aclose(self) -> None:
        """Release the upstream connection, including after cancellation."""
        reader, self._reader_task = self._reader_task, None
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
        callback, self._callback_task = self._callback_task, None
        if callback is not None:
            try:
                await asyncio.wait_for(self._callback_queue.join(), timeout=min(self._timeout, 0.1))
            except TimeoutError:
                pass
            self._callback_stop = True
            callback.cancel()
            await asyncio.wait({callback}, timeout=min(self._timeout, 0.02))
        socket, self._socket = self._socket, None
        if socket is not None:
            await asyncio.wait_for(socket.close(), timeout=self._timeout)
        self._partial_queue.put_nowait(_END)

    async def _run_callbacks(self) -> None:
        while not self._callback_stop:
            text = await self._callback_queue.get()
            try:
                if asyncio.iscoroutinefunction(self._on_partial):
                    result = self._on_partial(text)
                else:
                    result = await asyncio.to_thread(self._on_partial, text)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                # Progress display is optional; it must not affect the final result.
                pass
            finally:
                self._callback_queue.task_done()

    async def _read_events(self) -> None:
        try:
            while True:
                event = json.loads(await self._socket.recv())
                kind = event.get("type")
                item_id = event.get("item_id")
                if kind == "input_audio_buffer.committed" and item_id:
                    self._committed_id = item_id
                    if item_id in self._completed and self._final and not self._final.done():
                        self._final.set_result(self._completed[item_id])
                elif kind == "conversation.item.input_audio_transcription.delta" and item_id:
                    text = self._partials.get(item_id, "") + event.get("delta", "")
                    self._partials[item_id] = text
                    if self._committed_id in (None, item_id):
                        self._partial_queue.put_nowait(text)
                        if self._on_partial is not None:
                            self._callback_queue.put_nowait(text)
                elif kind == "conversation.item.input_audio_transcription.completed" and item_id:
                    transcript = event.get("transcript", "")
                    self._completed[item_id] = transcript
                    if item_id == self._committed_id and self._final and not self._final.done():
                        self._final.set_result(transcript)
                elif kind in {"error", "conversation.item.input_audio_transcription.failed"}:
                    detail = event.get("error") or event
                    raise RuntimeError(f"transcription failed: {detail}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._final is not None and not self._final.done():
                self._final.set_exception(exc)
