# Voice Router backend

Run commands from the repository root with Python 3.11+ and [uv](https://docs.astral.sh/uv/):

```bash
uv sync --project backend
uv run --project backend --env-file .env uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
uv run --project backend pytest backend/tests -q
```

The API and browser event shapes are documented in the [frontend contract](../frontend/docs/frontend.md). `GET /api/v1/health` checks the process. `POST /api/v1/sessions` with `{}` creates a session and returns its `session_id` and `ws_path`; connect to that path to exchange text or PCM16 mono 24 kHz audio. The API documentation is at `/docs`.

## Docker

From the repository root:

```bash
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8000/api/v1/health
docker compose logs --tail=100 backend
docker compose down
```

No host Python or uv is needed for Docker startup. The image uses Python 3.13, installs locked production dependencies, and runs one Uvicorn worker as a non-root user. Compose makes the filesystem read-only except `/tmp`. The five required catalog JSON files are bundled in `/app/datas`; calls change only an in-memory copy. There is no database, persistent volume, or frontend container. Do not add workers or replicas: sessions and LangGraph checkpoints are local to one process and are lost on restart.

Compose automatically reads the root `.env` for interpolation, with exported shell variables taking precedence. It passes only `OPENAI_API_KEY`, `ROUTER_MODEL`, and `FRONTEND_ORIGIN` into the container, plus the fixed `DATA_DIR=/app/datas`. All `.env` variants are excluded from the build context. Do not put keys into Docker build arguments, commit them, or share expanded `docker compose config` output. Runtime environment variables are still readable by administrators with access to the Docker daemon.

The default published address is `127.0.0.1:8000`, for local use only. Set `BACKEND_PORT=8001` in `.env` or the shell to change the host port. Set `FRONTEND_ORIGIN` to the exact frontend origin if it differs from `http://localhost:5173`; the browser connects directly to the published HTTP/WS port. Apply changed environment values with `docker compose up -d` (a simple restart does not reload them). External deployment additionally needs an explicit network exposure policy, HTTPS/WSS, and authentication; this Compose file is a local demo setup.

Health and catalog access do not need a provider key. The container healthcheck verifies the local HTTP process, not OpenAI availability. Live routing and audio require credentials. To check packaging without credentials or paid provider requests, run an isolated temporary instance:

```bash
OPENAI_API_KEY= BACKEND_PORT=18080 docker compose --env-file /dev/null -p voice-router-smoke up --build -d --wait --wait-timeout 60
uv run --project backend python backend/scripts/smoke_container.py --base-url http://127.0.0.1:18080
OPENAI_API_KEY= BACKEND_PORT=18080 docker compose --env-file /dev/null -p voice-router-smoke down
```

The smoke helper needs host uv/Python (unlike normal container startup). It checks HTTP and a deterministic WebSocket identity turn; missing-key speech output is allowed, but protocol or request failures exit nonzero. This verifies packaging, not live LLM/STT/TTS quality. The temporary project does not affect the normal Compose instance.

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Live router, speech transcription, and synthesis | Required for live provider calls |
| `ROUTER_MODEL` | Structured scenario selection through OpenAI Responses | `gpt-6-sol` |
| `FRONTEND_ORIGIN` | Allowed browser origin for CORS and WebSocket | `http://localhost:5173` |
| `DATA_DIR` | Directory containing the startup catalog and mock backend JSON | Repository `datas/` |

The audio adapters default to `gpt-live-transcribe` for speech recognition and `gpt-4o-mini-tts` with the `coral` voice for speech output. Provider credentials stay on the server. The test suite replaces providers with fakes and does not require an API key.

For the non-Docker commands, the root `.env` file is loaded explicitly by `--env-file .env`. When using only exported environment variables, omit that flag. Neither the application nor the evaluation script loads `.env` automatically; Docker Compose handles its own `.env` interpolation as described above.

### Safe speech-recognition diagnostics

STT failures produce a warning in the backend logs with `stage` (`init`, `feed`, or `finish`), an allowlisted `code`, `audio_bytes`, `audio_ms`, and `frames`. Audio totals count valid PCM received from the client, including a chunk whose upstream send failed; they do not prove the provider received it. Duration is calculated for PCM16 mono 24 kHz (48 bytes/ms). No audio, transcript, raw provider error, credentials, or request identifiers are included in these warnings.

```bash
docker compose logs --since=5m backend | rg 'STT failed'
```

`empty_audio` means the turn ended without PCM reaching the transcriber; `empty_transcript` means transcription returned no text. `timeout`, connection/HTTP codes, and allowlisted provider codes distinguish upstream failures. Unknown provider codes become `provider_error`, and unexpected application exceptions become `internal_error`. The browser still receives the safe, compatible `stt_unavailable` event. Diagnose the actual failed recording before changing microphone settings or models.

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
