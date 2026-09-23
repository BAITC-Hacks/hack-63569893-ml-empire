# Docker Backend Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this approved containerization task. Steps use checkbox syntax for tracking.

**Goal:** Run the existing backend with `docker compose up --build -d` without installing Python on the host.

**Architecture:** A multi-stage Python 3.13 slim image installs locked production dependencies with uv and runs FastAPI as a nonroot user. Compose publishes port 8000 locally and injects selected environment variables at runtime; the five catalog JSON files are included read-only in the image. No frontend service, database, or application behavior changes.

**Tech Stack:** Docker, Compose, Python 3.13, uv 0.12.1, the existing uv.lock and FastAPI/WebSocket API.

## Global Constraints

- One Uvicorn worker; restart loses in-memory sessions.
- Secrets and all `.env` variants stay out of build context and image layers.
- Do not edit the user's `.env` or `.env.example`.
- Set `DATA_DIR=/app/datas`; include scenarios, slots, actions, knowledge_base, and mock_backend JSON.
- Health is `GET /api/v1/health`, requiring no provider key.
- Local port defaults to 8000; runtime root filesystem is read-only with writable `/tmp`.
- Never print expanded Compose configuration, container environment, or credentials.

## Task 1: Image, Compose, and runtime verification

**Files:** Create `backend/Dockerfile`, root `.dockerignore`, root `compose.yaml`, `backend/scripts/smoke_container.py`; update `README.md`, `backend/README.md`.

**Interfaces:** `docker compose up --build -d`, `docker compose down`; optional `BACKEND_PORT`, `OPENAI_API_KEY`, `ROUTER_MODEL`, `FRONTEND_ORIGIN`. The smoke script accepts `--base-url`, verifies HTTP/catalog/session and a WebSocket identity turn with no provider key, and returns nonzero on protocol failure.

- [x] Write and run the smoke check against an unavailable localhost port; expect connection failure rather than a fabricated success.
- [x] Add a multi-stage Dockerfile using `python:3.13-slim-bookworm`, copy uv 0.12.1 only into the builder, and run `uv sync --locked --no-dev --no-editable`. Copy the installed virtual environment and five catalog files into the runtime; set a nonroot user, healthcheck, and exec-form Uvicorn command with `--workers 1`.
- [x] Add `.dockerignore` protecting `.env*`, git metadata, worktrees, Python environments, caches and unrelated frontend files. Copy only explicitly required source/catalog inputs in the Dockerfile.
- [x] Add Compose with a build context at the repository root, runtime environment interpolation, loopback port mapping, read-only root, temporary `/tmp`, dropped capabilities and no-new-privileges. Do not use build arguments for credentials.
- [x] Run `docker compose --env-file /dev/null config --quiet` without rendering secrets. Build the image. Start an isolated smoke project with an empty API key and a free host port, wait for health, then run `uv run --project backend python backend/scripts/smoke_container.py --base-url http://127.0.0.1:18080`.
- [x] Verify the runtime user is nonroot, catalog files cannot be written, no `.env` exists in the image, and the image can start without provider credentials. Stop only the temporary smoke project.
- [x] Run `uv run --project backend pytest backend/tests -q` and `git diff --check`. Review Docker/Compose and secret handling before integration.
- [x] Document build/start/stop, the optional host port, frontend origin, runtime key loading, single-process reset behavior, and the smoke command. Commit only task-owned files.

## Verification results — 2026-09-23

- Docker image built successfully; Compose reached `healthy` with no API key.
- Container smoke passed: HTTP health, 40 scenarios, session creation, six identity-turn events, duplicate rejection, and restored session summary. Missing-key TTS fallback was expected.
- Runtime inspection confirmed UID/GID 10001, read-only root and catalogs, all capabilities dropped, no-new-privileges, and loopback publication. No `.env` files or pytest were present in `/app`.
- All 224 backend tests passed; whitespace checks and independent packaging review found no issues.
- The temporary `voice-router-smoke` container and network were removed after verification.
