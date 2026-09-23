"""TTS client ownership and app shutdown behavior without provider calls."""

import pytest
from fastapi.testclient import TestClient

from app.audio.tts import Synthesizer
from app.main import create_app


class SpeechResponse:
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def iter_bytes(self, chunk_size=None):
        for chunk in self.chunks:
            yield chunk


class Speech:
    def __init__(self, client):
        self.client = client

    def create(self, **kwargs):
        self.client.requests += 1
        if self.client.fail_next:
            self.client.fail_next = False
            raise OSError("temporary provider failure")
        return SpeechResponse([b"\x01\x00"])


class Client:
    def __init__(self, *, fail_next=False):
        self.fail_next = fail_next
        self.requests = 0
        self.closed = False
        speech = Speech(self)
        self.audio = type("Audio", (), {"speech": type("Wrapper", (), {"with_streaming_response": speech})()})()

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_two_streams_reuse_one_lazy_client(monkeypatch):
    """Separate turns should not open a new SDK connection pool each time."""
    created = []

    def factory():
        client = Client()
        created.append(client)
        return client

    monkeypatch.setattr("openai.AsyncOpenAI", factory)
    synth = Synthesizer()
    assert not created
    assert [part async for part in synth.stream("Сәлем", "kk")] == [b"\x01\x00"]
    assert [part async for part in synth.stream("Привет", "ru")] == [b"\x01\x00"]
    assert len(created) == 1
    assert created[0].requests == 2


@pytest.mark.asyncio
async def test_injected_client_remains_open_after_synthesizer_cleanup():
    """A caller supplied client keeps its own lifecycle."""
    client = Client()
    synth = Synthesizer(client=client)
    assert [part async for part in synth.stream("Сәлем", "kk")] == [b"\x01\x00"]
    await synth.aclose()
    assert not client.closed


@pytest.mark.asyncio
async def test_owned_client_closes_on_synthesizer_cleanup(monkeypatch):
    """A lazily created client must release its connections at shutdown."""
    client = Client()
    monkeypatch.setattr("openai.AsyncOpenAI", lambda: client)
    synth = Synthesizer()
    await synth.aclose()
    assert not client.closed
    assert [part async for part in synth.stream("Сәлем", "kk")] == [b"\x01\x00"]
    await synth.aclose()
    assert client.closed


@pytest.mark.asyncio
async def test_failed_stream_reuses_client_on_next_turn(monkeypatch):
    """A provider error must not force another SDK client allocation."""
    client = Client(fail_next=True)
    created = []

    def factory():
        created.append(client)
        return client

    monkeypatch.setattr("openai.AsyncOpenAI", factory)
    synth = Synthesizer()
    with pytest.raises(OSError, match="temporary provider failure"):
        [part async for part in synth.stream("Сәлем", "kk")]
    assert [part async for part in synth.stream("Сәлем", "kk")] == [b"\x01\x00"]
    assert len(created) == 1
    assert client.requests == 2


def test_app_lifespan_closes_only_default_synthesizer(monkeypatch):
    """App shutdown releases its synth while injected doubles need no cleanup."""
    owned = Client()
    monkeypatch.setattr("openai.AsyncOpenAI", lambda: owned)
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/health").status_code == 200
        synth = client.app.state.synthesizer
        assert client.portal.call(collect, synth.stream("Сәлем", "kk")) == [b"\x01\x00"]
    assert owned.closed
    with TestClient(create_app(synthesizer=object())) as client:
        assert client.get("/api/v1/health").status_code == 200


async def collect(stream):
    return [part async for part in stream]
