"""Contract tests for the external audio adapters (no network calls)."""

import asyncio
import base64
import json

import pytest

from app.audio import Synthesizer, Transcriber


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.incoming = asyncio.Queue()
        self.closed = False

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        return await self.incoming.get()

    async def close(self):
        self.closed = True

    def emit(self, event):
        self.incoming.put_nowait(json.dumps(event))


@pytest.mark.asyncio
async def test_transcriber_commits_pcm_and_returns_matching_final_only():
    """A mismatched completion must never become this turn's transcript."""
    socket = FakeSocket()

    async def connect(*args, **kwargs):
        return socket

    transcriber = Transcriber(connector=connect, api_key="test-key")
    await transcriber.feed(b"\x01\x00\x02\x00")
    assert socket.sent[0]["session"]["audio"]["input"]["transcription"]["model"] == "gpt-live-transcribe"
    assert socket.sent[0]["session"]["audio"]["input"]["turn_detection"] is None
    assert socket.sent[1] == {
        "type": "input_audio_buffer.append",
        "audio": base64.b64encode(b"\x01\x00\x02\x00").decode("ascii"),
    }

    task = asyncio.create_task(transcriber.finish())
    await asyncio.sleep(0)
    assert socket.sent[-1] == {"type": "input_audio_buffer.commit"}
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "other", "transcript": "wrong"})
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Привет"})
    assert await task == "Привет"
    assert socket.closed


@pytest.mark.asyncio
async def test_transcriber_emits_cumulative_partials_without_completing_turn():
    """Deltas are progress only; finish awaits the committed item's final text."""
    socket = FakeSocket()
    partials = []
    partials_seen = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def connect(*args, **kwargs):
        return socket

    def on_partial(text):
        partials.append(text)
        if len(partials) == 2:
            loop.call_soon_threadsafe(partials_seen.set)

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=on_partial)
    await transcriber.feed(b"\x00\x00")
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "Сә"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "лем"})
    task = asyncio.create_task(transcriber.finish())
    await asyncio.sleep(0)
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    await asyncio.wait_for(partials_seen.wait(), timeout=0.2)
    assert partials == ["Сә", "Сәлем"]
    assert not task.done()
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Сәлем!"})
    assert await task == "Сәлем!"


@pytest.mark.asyncio
async def test_transcriber_rejects_misaligned_pcm():
    """A half sample must not be sent to the provider."""
    transcriber = Transcriber(connector=None, api_key="test-key")
    with pytest.raises(ValueError, match="PCM16"):
        await transcriber.feed(b"\x00")


class FakeSpeechResponse:
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def aiter_bytes(self, chunk_size):
        for chunk in self.chunks:
            yield chunk


class FakeSpeech:
    def __init__(self, chunks):
        self.chunks = chunks
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return FakeSpeechResponse(self.chunks)


class FakeClient:
    def __init__(self, chunks):
        self.speech = FakeSpeech(chunks)
        self.audio = type("Audio", (), {"speech": type("Wrapper", (), {"with_streaming_response": self.speech})()})()


@pytest.mark.asyncio
async def test_synthesizer_streams_raw_pcm_chunks_with_language_instruction():
    """The consumer receives playable PCM bytes, in order, for Kazakh text."""
    client = FakeClient([b"\x01\x00", b"\x02\x00"])
    chunks = [chunk async for chunk in Synthesizer(client=client).stream("Сәлем", "kk")]
    assert chunks == [b"\x01\x00", b"\x02\x00"]
    assert client.speech.kwargs["model"] == "gpt-4o-mini-tts"
    assert client.speech.kwargs["response_format"] == "pcm"
    assert client.speech.kwargs["input"] == "Сәлем"
    assert "Kazakh" in client.speech.kwargs["instructions"]


@pytest.mark.asyncio
async def test_synthesizer_keeps_pcm_samples_whole_across_provider_chunks():
    """An HTTP chunk ending mid-sample must not become an invalid PCM frame."""
    client = FakeClient([b"\x01", b"\x00\x02", b"\x00"])
    chunks = [chunk async for chunk in Synthesizer(client=client).stream("Привет", "ru")]
    assert chunks == [b"\x01\x00", b"\x02\x00"]


@pytest.mark.asyncio
async def test_transcriber_surfaces_provider_error_and_closes_connection():
    """An upstream error must fail finish promptly and release the socket."""
    socket = FakeSocket()

    async def connect(*args, **kwargs):
        return socket

    transcriber = Transcriber(connector=connect, api_key="test-key")
    await transcriber.feed(b"\x00\x00")
    task = asyncio.create_task(transcriber.finish())
    await asyncio.sleep(0)
    socket.emit({"type": "error", "error": {"message": "unavailable"}})
    with pytest.raises(RuntimeError, match="unavailable"):
        await task
    assert socket.closed


@pytest.mark.asyncio
async def test_transcriber_closes_failed_setup_and_reconnects_on_next_feed():
    """A failed session.update cannot leave a half-initialized socket reusable."""
    class FailingSetupSocket(FakeSocket):
        async def send(self, message):
            raise OSError("setup failed")

    first, second = FailingSetupSocket(), FakeSocket()
    sockets = iter((first, second))

    async def connect(*args, **kwargs):
        return next(sockets)

    transcriber = Transcriber(connector=connect, api_key="test-key")
    with pytest.raises(OSError, match="setup failed"):
        await transcriber.feed(b"\x00\x00")
    assert first.closed
    await transcriber.feed(b"\x01\x00")
    assert second.sent[0]["type"] == "session.update"
    assert second.sent[1]["type"] == "input_audio_buffer.append"
    await transcriber.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_event", ["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"])
async def test_transcriber_bounds_each_upstream_send(blocked_event):
    """A stalled WebSocket send must time out before the caller's guard."""
    class BlockingSocket(FakeSocket):
        async def send(self, message):
            event = json.loads(message)
            if event["type"] == blocked_event:
                await asyncio.Event().wait()
            await super().send(message)

    socket = BlockingSocket()

    async def connect(*args, **kwargs):
        return socket

    transcriber = Transcriber(connector=connect, api_key="test-key", timeout=0.01)
    start = asyncio.get_running_loop().time()
    if blocked_event == "input_audio_buffer.commit":
        await transcriber.feed(b"\x00\x00")
        operation = transcriber.finish()
    else:
        operation = transcriber.feed(b"\x00\x00")
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(operation, timeout=0.2)
    assert asyncio.get_running_loop().time() - start < 0.15
    assert socket.closed


@pytest.mark.asyncio
async def test_transcriber_final_survives_raising_partial_callback():
    """UI progress callback errors cannot replace a valid final transcript."""
    socket = FakeSocket()

    async def connect(*args, **kwargs):
        return socket

    def on_partial(_text):
        raise RuntimeError("UI unavailable")

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=on_partial)
    await transcriber.feed(b"\x00\x00")
    task = asyncio.create_task(transcriber.finish())
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "Прив"})
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Привет"})
    assert await asyncio.wait_for(task, timeout=0.2) == "Привет"


@pytest.mark.asyncio
async def test_transcriber_final_survives_slow_partial_callback():
    """A waiting async UI callback cannot delay the final transcript."""
    socket = FakeSocket()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def connect(*args, **kwargs):
        return socket

    async def on_partial(_text):
        entered.set()
        await release.wait()

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=on_partial)
    await transcriber.feed(b"\x00\x00")
    task = asyncio.create_task(transcriber.finish())
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "Прив"})
    await asyncio.wait_for(entered.wait(), timeout=0.2)
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Привет"})
    try:
        assert await asyncio.wait_for(task, timeout=0.2) == "Привет"
    finally:
        release.set()


@pytest.mark.asyncio
async def test_transcriber_awaits_callable_object_partial_result():
    """An async __call__ must deliver progress, even though the object is not a coroutine function."""
    socket = FakeSocket()
    delivered = asyncio.Event()

    async def connect(*args, **kwargs):
        return socket

    class PartialSink:
        async def __call__(self, text):
            if text == "Сәлем":
                delivered.set()

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=PartialSink())
    await transcriber.feed(b"\x00\x00")
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "Сәлем"})
    await asyncio.wait_for(delivered.wait(), timeout=0.2)
    await transcriber.aclose()


@pytest.mark.asyncio
async def test_transcriber_drains_queued_partials_before_returning_final():
    """A prompt final event must not discard partials already read from upstream."""
    socket = FakeSocket()
    delivered = []
    first_started = asyncio.Event()
    release = asyncio.Event()

    async def connect(*args, **kwargs):
        return socket

    async def on_partial(text):
        first_started.set()
        await release.wait()
        delivered.append(text)

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=on_partial)
    await transcriber.feed(b"\x00\x00")
    task = asyncio.create_task(transcriber.finish())
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "При"})
    await asyncio.wait_for(first_started.wait(), timeout=0.2)
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "вет"})
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Привет"})
    await asyncio.sleep(0.01)
    release.set()
    assert await asyncio.wait_for(task, timeout=0.2) == "Привет"
    assert delivered == ["При", "Привет"]


@pytest.mark.asyncio
async def test_transcriber_cleanup_is_bounded_when_callback_ignores_cancellation():
    """A callback that handles cancellation must not hold the completed turn open."""
    socket = FakeSocket()
    callback_started = asyncio.Event()
    release = asyncio.Event()

    async def connect(*args, **kwargs):
        return socket

    async def on_partial(_text):
        callback_started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            await release.wait()

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=on_partial, timeout=0.2)
    await transcriber.feed(b"\x00\x00")
    task = asyncio.create_task(transcriber.finish())
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "При"})
    await asyncio.wait_for(callback_started.wait(), timeout=0.2)
    socket.emit({"type": "conversation.item.input_audio_transcription.completed", "item_id": "ours", "transcript": "Привет"})
    started = asyncio.get_running_loop().time()
    try:
        assert await asyncio.wait_for(task, timeout=0.3) == "Привет"
        assert asyncio.get_running_loop().time() - started < 0.25
    finally:
        release.set()
