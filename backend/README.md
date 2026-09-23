# Voice Router backend

Run commands from the repository root with Python 3.11+ and [uv](https://docs.astral.sh/uv/):

```bash
uv sync --project backend
uv run --project backend --env-file .env uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
uv run --project backend pytest backend/tests -q
```

The API and browser event shapes are documented in the [frontend contract](../frontend/docs/frontend.md). `GET /api/v1/health` checks the process. `POST /api/v1/sessions` with `{}` creates a session and returns its `session_id` and `ws_path`; connect to that path to exchange text or PCM16 mono 24 kHz audio. The API documentation is at `/docs`.

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Live router, speech transcription, and synthesis | Required for live provider calls |
| `ROUTER_MODEL` | Structured scenario selection through OpenAI Responses | `gpt-6-sol` |
| `FRONTEND_ORIGIN` | Allowed browser origin for CORS and WebSocket | `http://localhost:5173` |
| `DATA_DIR` | Directory containing the startup catalog and mock backend JSON | Repository `datas/` |

The audio adapters default to `gpt-live-transcribe` for speech recognition and `gpt-4o-mini-tts` with the `coral` voice for speech output. Provider credentials stay on the server. The test suite replaces providers with fakes and does not require an API key.

The root `.env` file is loaded explicitly by `--env-file .env`. When using only exported environment variables, omit that flag. Neither the application nor the evaluation script loads `.env` automatically.

## Text WebSocket cycle

Create a session, then connect to the returned `ws_path`. For example, with a WebSocket client such as `websocat`:

```bash
curl -s -X POST http://localhost:8000/api/v1/sessions -H 'Content-Type: application/json' -d '{}'
websocat ws://localhost:8000/api/v1/sessions/SESSION_ID/stream
```

After `session.ready`, send this JSON frame, replacing `turn_id` with a fresh UUID for each turn:

```json
{"type":"turn.text","turn_id":"e54c4ce0-4976-4604-b21b-d31b7f2be6d8","payload":{"text":"Где ваш офис в Алматы?"}}
```

Read `route.decision`, `agent.text`, `trace.updated`, and `turn.complete` events. A confirmation is a new `turn.text` with a new `turn_id`; an `action.preview` never performs the action. The full event protocol and audio format are in the [frontend contract](../frontend/docs/frontend.md).

## Demo data and limits

`datas/` is read at startup and is not modified by calls. The mock backend uses `2026-10-01` as its fixed date, independent of the machine clock. Each call has an isolated in-memory copy of mock data and LangGraph checkpoint state. Restarting the process loses sessions and changes; run a single server process for the demo, with no worker replication or persistent storage.

The dialogue tests use annotated turns from `datas/dialogs_sample.json` against the real graph, catalog, and action engine, with a fake router. They are integration checks, not a measured model accuracy score. For a live routing evaluation, when a provider key is available, run:

```bash
uv run --project backend --env-file .env python backend/scripts/evaluate_router.py --model gpt-6-sol
```

## Live smoke verification — 2026-09-23

With credentials loaded from the root `.env`, three Russian, Kazakh, and mixed-language requests selected the expected routes (`SC33`, `SC33`, `SC13`), taking 4957, 3150, and 4529 ms respectively. A live text WebSocket turn completed through the graph and TTS without errors, returning 540,000 PCM bytes.

The final synthetic TTS → STT roundtrip returned the exact phrase `Где ваш офис в Алматы?`: synthesis produced 146,400 PCM bytes (3.05 seconds of audio), with its first chunk after 1.784 seconds and completion after 2.530 seconds. Transcription took 6.173 seconds. These are individual adapter smoke checks, not quality benchmarks or latency guarantees.

Full-dev routing accuracy and browser end-of-speech-to-playback latency remain unmeasured. In a browser, measure actual playback start using `playback.started`; neither synthetic roundtrips nor the offline test suite establish that metric.
