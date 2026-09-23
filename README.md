# Voice Router — Saqta Insurance

Hackathon demo of a bilingual insurance voice assistant. It routes Russian and Kazakh requests through a scenario catalog, keeps call context, and asks for explicit confirmation before changing mock backend data. All customers and policies are synthetic; the dataset snapshot treats `2026-10-01` as today.

## Project documents

- [Архитектура решения](docs/voice-router-architecture.md)
- [План разработки бэкенда](docs/superpowers/plans/2026-09-23-voice-router-backend.md)
- [Контракт подключения фронтенда](frontend/docs/frontend.md)
- [Функции и запуск фронтенда](frontend/README.md)
- [Визуальный стиль Halyk для интерфейса](frontend/docs/halyk-visual-style-analysis.md)
- [Описание датасета и условий кейса](datas/README.ru.md)
- [Покрытие требований банка, frontend-плана и критериев оценки](frontend/docs/requirements-coverage.md)
- [Проверки и оставшаяся голосовая приёмка](frontend/docs/frontend-verification.md)

## Локальная проверка фронтенда

```bash
npm --prefix frontend ci
npm --prefix frontend run dev:fixture
```

UI: `http://127.0.0.1:5175`. Это **синтетический тестовый сервер**, не LLM/STT/TTS-робот. Не вводите реальные персональные данные. `Ctrl+C` останавливает оба локальных сервиса. Для подключения настоящего API: `npm --prefix frontend run dev`; подробности в [frontend README](frontend/README.md).

Готовность клиента не означает прохождение полного ТЗ: реальная маршрутизация, голосовые провайдеры, измерения на устройстве и общий запуск всего решения ещё требуют интеграции.

## Run with Docker

From the repository root, with Docker Engine and Compose installed:

```bash
docker compose up --build -d
docker compose ps
```

Compose reads the root `.env` and passes `OPENAI_API_KEY`, `ROUTER_MODEL`, and `FRONTEND_ORIGIN` to the backend at runtime. Credentials are not included in the image. The API is at `http://localhost:8000`, interactive docs at `http://localhost:8000/docs`. The frontend runs separately; the default allowed origin is `http://localhost:5173`.

Stop with `docker compose down`. Sessions and mock changes are in memory and disappear on restart. See the [Docker guide](backend/README.md#docker) for configuration and smoke checks.

## Run locally without Docker

From the repository root, with [uv](https://docs.astral.sh/uv/) installed:

```bash
uv sync --project backend
uv run --project backend --env-file .env uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

Set `OPENAI_API_KEY` in the root `.env` file or your environment for live routing and audio. The command above explicitly loads `.env`; it is not loaded automatically. If you only use exported environment variables, omit `--env-file .env`. The API is at `http://localhost:8000`; see the [backend guide](backend/README.md) for configuration, a text WebSocket example, and tests.
