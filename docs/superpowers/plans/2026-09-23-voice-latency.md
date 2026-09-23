# Voice latency implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. User approved immediate parallel implementation; no further design checkpoints.

**Goal:** Reduce successful scenario selection toward 500 ms and final STT to first response audio toward 1500 ms, measuring actual results without hiding failures.

**Architecture:** Keep FastAPI, LangGraph, full-catalog LLM routing and PCM streaming. Reduce router generation, reuse TTS connections, remove avoidable audio buffering and expose the requested timing boundary. Model changes must pass comparative evaluation; do not replace the router with a trained intent classifier or execute actions speculatively.

**Tech Stack:** Python, LangChain/OpenAI Responses, LangGraph, FastAPI WebSocket, React/Web Audio, Docker.

## Global Constraints

- Preserve public route/event schemas, all catalog exclusions, bilingual and multiple-intent routing, explicit confirmation and at-most-once execution.
- Never log or save credentials, user speech or user transcripts. Live evaluations use bundled synthetic utterances only.
- Report cold/warm samples, p50/p95, failures and quality; a 500 ms timeout is not a successful 500 ms route.
- No background pre-generation, global personalized-audio cache, premium service tier, or speech provider migration in this iteration.
- Worktree: `/home/alexseyka/.codex/worktrees/voice-latency/hack-63569893-ml-empire`; parent coordinates commits and local main integration. Agents own disjoint files.

### Task 1: TTS client reuse and unbuffered delivery

**Files:** `backend/app/audio/tts.py`, `backend/app/main.py`, `backend/tests/test_audio.py`, new `backend/tests/test_tts_lifecycle.py`.
**Interfaces:** Existing `Synthesizer.stream(text, language)` remains async PCM iterator; add `async aclose()` for internally owned client only. FastAPI lifespan closes the default synthesizer, without assuming injected test doubles expose cleanup.

- [x] Add failing tests for two streams creating one client, injected-client ownership, owned shutdown, failed-stream reuse, and first sub-4096-byte PCM arriving before upstream EOF.
  ```python
  first = await anext(synth.stream("Сәлем", "kk"))
  assert first == b"\x01\x00"
  ```
- [x] Run `uv run --project backend pytest backend/tests/test_audio.py backend/tests/test_tts_lifecycle.py -q`, verify RED.
- [x] Lazily retain one AsyncOpenAI client; default `chunk_size=None`; preserve odd-byte carry and timeout. Close owned resources through FastAPI lifespan, preserving keyless health/startup.
- [x] Run focused tests, report RED/GREEN. Do not change models/voices or persist audio.

### Task 2: Compact successful LLM routing

**Files:** `backend/app/router.py`, `backend/app/config.py`, `backend/tests/test_router.py`, `backend/tests/test_config.py`.
**Interfaces:** `LLMRouter.route(text, RouterContext) -> RouterDecision` and public fields unchanged. Settings add configurable router reasoning effort, default `none`, while allowing `low` baseline.

- [x] Write failing tests proving compact provider output converts into the unchanged full RouterDecision; validate unknown IDs, duplicate slots and multiple intents exactly as before.
  ```python
  assert result.scenarios[0].scenario_id == "SC33"
  assert result.slots == {"city": "Almaty"}
  ```
- [x] Run router/config focused tests and verify RED.
- [x] Minimize model-output syntax with short internal aliases; retain injectable legacy structured-result compatibility. Require only supplied slots, short evidence-based reasons and at most two alternatives; preserve every scenario description and exclusion. Configure no-reasoning and bounded retries/output without making the success deadline 500 ms. Do not change default model until parent compares quality.
- [x] Run focused tests and report actual wire shape and settings to parent for live evaluation.

### Task 3: Explicit post-STT latency

**Files:** `backend/app/api/ws.py`, `backend/tests/test_ws_audio.py`, `frontend/src/trace-view.ts` only if a relevant existing display mapper requires it (otherwise report).
**Interfaces:** Add `latency_ms.post_stt_first_audio` to flexible trace latency dictionary; preserve every existing timing and event ordering. Start timestamp immediately after validated final STT text (or at process entry for text turns), end after first WebSocket PCM send.

- [x] Add failing integration test with a controlled delayed transcriber and gated TTS verifying STT wait is excluded, while `server_first_audio` still includes it.
  ```python
  assert trace["latency_ms"]["post_stt_first_audio"] < trace["latency_ms"]["server_first_audio"]
  ```
- [x] Run `uv run --project backend pytest backend/tests/test_ws_audio.py -q`, verify RED.
- [x] Pass post-STT timestamp to audio_reply and emit explicit metric only after actual first audio send; do not fabricate zero for no audio.
- [x] Run focused tests; report that this is server send time, not physical speaker output.

### Task 4: Comparative evaluation, review and deployment

**Files:** `backend/scripts/evaluate_router.py`, `backend/README.md`, `compose.yaml` if passing new setting is needed; docs measurement artifact with synthetic dataset IDs/aggregate timings only.

- [x] Extend CLI to evaluate selected effort and emit JSON route predictions/timings, p50/p95 and target violation counts, preserving current defaults/CLI usage. Test metrics/arguments offline before implementation.
- [x] Run baseline and candidate on the same 104 synthetic utterances. Prefer faster model/config only when observed accuracy and urgent/multi-intent handling do not regress; otherwise retain baseline and report target gap.
- [x] Run full backend/frontend checks and independent review. Resolve concrete findings before local merge.
- [x] Merge locally in main, rebuild Docker, verify runtime source matches and health is good. Re-run representative full WebSocket turns and report measured router, first TTS PCM and post-STT timing, without claiming an acoustic/browser benchmark.

### Measured follow-up: cold runtime loading

- [x] After the first deployed turn exposed about 1305 ms outside routing and TTS, move default graph imports/assembly into FastAPI lifespan. Add a failing startup test first; preserve keyless startup and injected processors, perform no provider calls or synthetic turns. Focused 28 tests and full 281 tests pass; independent follow-up review found no blockers.

The implementation steps are complete; the latency goal is not. See `docs/benchmarks/2026-09-23-voice-latency.md` for real-provider measurements and remaining gap.
