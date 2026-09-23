"""Streaming OpenAI speech adapter yielding raw PCM16 mono 24 kHz."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any


_LANGUAGE_INSTRUCTIONS = {
    "ru": "Speak naturally in Russian.",
    "kk": "Speak naturally in Kazakh.",
    "mixed": "Speak naturally, preserving the Russian and Kazakh in the input.",
}


class Synthesizer:
    def __init__(
        self,
        *,
        client: Any = None,
        model: str = "gpt-4o-mini-tts",
        voice: str = "coral",
        timeout: float = 30.0,
        chunk_size: int | None = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._model = model
        self._voice = voice
        self._timeout = timeout
        self._chunk_size = chunk_size

    async def stream(self, text: str, language: str) -> AsyncIterator[bytes]:
        """Yield provider audio as it arrives, without a WAV header."""
        if not text.strip():
            return
        client = self._client
        if client is None:
            from openai import AsyncOpenAI

            client = self._client = AsyncOpenAI()
        instructions = _LANGUAGE_INSTRUCTIONS.get(language, "Speak naturally in the language of the input.")
        trailing_byte = b""
        async with asyncio.timeout(self._timeout):
            async with client.audio.speech.with_streaming_response.create(
                model=self._model,
                voice=self._voice,
                input=text,
                instructions=instructions,
                response_format="pcm",
            ) as response:
                async for chunk in response.iter_bytes(chunk_size=self._chunk_size):
                    samples = trailing_byte + chunk
                    complete_length = len(samples) & ~1
                    if complete_length:
                        yield samples[:complete_length]
                    trailing_byte = samples[complete_length:]
                if trailing_byte:
                    raise ValueError("TTS returned an incomplete PCM16 sample")

    async def aclose(self) -> None:
        """Close only the SDK client created by this synthesizer."""
        if self._owns_client and self._client is not None:
            client = self._client
            self._client = None
            await client.close()
