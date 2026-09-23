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

    async def connect(*args, **kwargs):
        return socket

    transcriber = Transcriber(connector=connect, api_key="test-key", on_partial=partials.append)
    await transcriber.feed(b"\x00\x00")
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "Сә"})
    socket.emit({"type": "conversation.item.input_audio_transcription.delta", "item_id": "ours", "delta": "лем"})
    task = asyncio.create_task(transcriber.finish())
    await asyncio.sleep(0)
    socket.emit({"type": "input_audio_buffer.committed", "item_id": "ours"})
    await asyncio.sleep(0)
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
