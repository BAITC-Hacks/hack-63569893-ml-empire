# Voice Router — Saqta Insurance

Hackathon demo of a bilingual insurance voice assistant. It routes Russian and Kazakh requests through a scenario catalog, keeps call context, and asks for explicit confirmation before changing mock backend data. All customers and policies are synthetic; the dataset snapshot treats `2026-10-01` as today.

## Run locally

From the repository root, with [uv](https://docs.astral.sh/uv/) installed:

```bash
uv sync --project backend
uv run --project backend uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

Set `OPENAI_API_KEY` in your environment for live routing and audio. The API is at `http://localhost:8000`; see the [backend guide](backend/README.md) for configuration, a text WebSocket example, and tests.

## Project documents

- [Frontend integration contract](frontend/docs/frontend.md)
- [Architecture](docs/voice-router-architecture.md)
- [Dataset and case details](datas/README.ru.md)
- [Backend implementation plan](docs/superpowers/plans/2026-09-23-voice-router-backend.md)
