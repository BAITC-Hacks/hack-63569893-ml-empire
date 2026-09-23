# Voice Router Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запустить FastAPI-бэкенд голосового симулятора, который через LangGraph и LLM выбирает сценарии, безопасно исполняет мок-действия и отдаёт фронтенду текст, аудио и трассировку.

**Architecture:** Один FastAPI-процесс держит сессии и checkpointer LangGraph в памяти для хакатонного демо. `ChatOpenAI` через Responses API выдаёт структурированное решение, а граф применяет правила сценариев, управляет слотами и подтверждением; отдельные адаптеры обслуживают STT/TTS. HTTP создаёт и восстанавливает сессию, WebSocket переносит реплики и аудио по контракту [frontend.md](../../../frontend/docs/frontend.md).

**Tech Stack:** Python 3.11+, FastAPI, Pydantic 2, LangGraph, `langchain-openai`, OpenAI Python SDK, `uv`, pytest, httpx, websockets.

**Spec:** [Voice Router architecture](../../voice-router-architecture.md); интерфейс для браузера — [frontend.md](../../../frontend/docs/frontend.md).

## Global Constraints

- Источники данных: `datas/scenarios.json`, `slots.json`, `actions.json`, `knowledge_base.json`, `mock_backend.json`; фиксированная дата набора — `2026-10-01`.
- Бизнес-сценарий выбирает LLM; обученный энкодерный intent-классификатор и сопоставление dev-фраз по точному тексту исключены.
- Поддержать `SC01`–`SC40` и три `SYS_*`; при нескольких намерениях `urgent` идёт первым, остальные сохраняются.
- Один вопрос за реплику, явное подтверждение перед действиями с `irreversible=true`, повтор действия предотвращает `action_id`.
- Первая голосовая версия использует push-to-talk, PCM16 mono 24 kHz и один активный `turn_id` на сессию.
- Один процесс и хранение в памяти допустимы для демо; перезапуск сбрасывает сессии. Точный способ запуска и это ограничение указать в README.
- `datas/` включён в репозиторий как стартовый набор; обработчики используют его для чтения и создают копию `mock_backend.json` на каждую сессию, не меняя исходные файлы.

## Review Focus

Пять особенно важных входов, для каждого ниже указан тест задачи-владельца:

1. «Авария» различается как SC11/SC12/SC13 по фактам, а не ключевому слову — `test_router_distinguishes_car_claims` в задаче 4.
2. Казахская реплика со смешанным русским фрагментом сохраняет основной сценарий и язык ответа — `test_router_mixed_language` в задаче 4.
3. Несколько намерений, включая срочное, не теряются и исполняются в нужном порядке — `test_urgent_multi_intent_keeps_queue` в задаче 5.
4. «Да» без ожидающего подтверждения или повтор `action_id` не создают второй полис/кейс — `test_confirmation_is_required_and_idempotent` в задаче 3.
5. Повтор WebSocket `turn_id` не запускает маршрутизацию второй раз, а ошибка TTS сохраняет текстовый ответ — `test_duplicate_turn_and_tts_failure` в задаче 7.

## Карта файлов

| Файл | Ответственность |
| --- | --- |
| `backend/pyproject.toml` | Зависимости, Python, команды тестирования. |
| `backend/app/config.py`, `catalog.py`, `domain.py` | Настройки, чтение и проверка стартового набора, типы решений/состояния. |
| `backend/app/actions.py` | Реестр 31 мок-действия, ошибки, изоляция данных сессии и идемпотентность. |
| `backend/app/router.py` | `ChatOpenAI`, компактный промпт и структурированный вывод. |
| `backend/app/graph.py`, `reply.py` | Узлы LangGraph, политика диалога и ответы из проверенных фактов. |
| `backend/app/sessions.py`, `api/contracts.py`, `api/http.py`, `api/ws.py`, `main.py` | Сессии, HTTP/WS-контракт, последовательность событий и приложение. |
| `backend/app/audio/stt.py`, `audio/tts.py` | Провайдеры голоса и поток PCM. |
| `backend/tests/`, `backend/scripts/evaluate_router.py`, `backend/README.md` | Проверки, dev-оценка и запуск. |

## Task 1: Каркас и проверяемый каталог

**Files:** Create `backend/pyproject.toml`, `backend/uv.lock`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/domain.py`, `backend/app/catalog.py`, `backend/tests/test_catalog.py`.

**Interfaces:** `Catalog.load(data_dir: Path) -> Catalog`; поля `scenarios: dict[str, ScenarioSpec]`, `system_intents: set[str]`, `actions: dict[str, ActionSpec]`, `error_codes: dict[str, str]`, `slots: dict[str, dict]`, `knowledge_base: dict`, `mock_backend: dict`. `Settings.data_dir` указывает на корневой `datas/` и проверяется при старте.

- [ ] **Step 1: Написать тест каталога.** Проверить 40 сценариев, 3 системных намерения, 31 действие, уникальные ID и существование всех ссылок `scenario.actions` и `scenario.slots.required`.

```python
def test_catalog_references_are_valid():
    catalog = Catalog.load(Path(__file__).parents[2] / "datas")
    assert len(catalog.scenarios) == 40
    assert len(catalog.system_intents) == 3
    assert len(catalog.actions) == 31
    assert all(a in catalog.actions for s in catalog.scenarios.values() for a in s.actions)
```

- [ ] **Step 2: Убедиться, что тест падает.** `uv run --project backend pytest backend/tests/test_catalog.py -q` → ошибка импорта `Catalog`.
- [ ] **Step 3: Реализовать загрузку с проверкой схемы и ссылок.** В `pyproject.toml` закрепить зависимости из Tech Stack, `ScenarioSpec` и `ActionSpec` определить в `domain.py`; `Catalog.load` читает JSON один раз при старте и выдаёт понятную ошибку при отсутствии файла. Проект установить как пакет, чтобы `app` импортировался из тестов и скрипта, запущенных из корня репозитория.

```toml
[project]
name = "voice-router-backend"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["fastapi", "uvicorn[standard]", "pydantic>=2", "langgraph", "langchain-openai", "openai", "websockets"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["app"]

[dependency-groups]
dev = ["pytest", "pytest-asyncio", "httpx"]
```

```python
scenario_ids = [row["scenario_id"] for row in scenarios_json["scenarios"]]
if len(scenario_ids) != len(set(scenario_ids)):
    raise ValueError("Duplicate scenario_id in scenarios.json")
for row in scenarios_json["scenarios"]:
    unknown = set(row["actions"]) - set(action_specs)
    if unknown:
        raise ValueError(f"{row['scenario_id']}: unknown actions {sorted(unknown)}")
```

- [ ] **Step 4: Зафиксировать `backend/uv.lock`, запустить тест и проверить проход.** `uv lock --project backend`; `uv run --project backend pytest backend/tests/test_catalog.py -q` → PASS.
- [ ] **Step 5: Коммит.** `git add backend/pyproject.toml backend/uv.lock backend/app backend/tests/test_catalog.py`; `git commit -m "feat: load Voice Router catalog"`.

## Task 2: Необратимость, мок-действия и ошибки

**Files:** Create `backend/app/actions.py`, `backend/tests/test_actions.py`.

**Interfaces:** `ActionEngine(catalog).new_session(session_id) -> SessionActions`; `SessionActions.call(name: str, inputs: dict, *, action_id: str | None = None, confirmed: bool = False) -> dict`. Каждый новый звонок получает копию `mock_backend.json`; оригинальный файл не меняется. Возврат ошибки соответствует `actions.json`: `{"error":{"code":"not_found","message":"Client not found"}}`.

- [ ] **Step 1: Написать тесты lookup, ошибки `not_found`, изоляции двух звонков и покрытия всех 31 имён.** Для каждого не-`irreversible` действия определить вход и ожидаемый тип результата по `actions.json`, проверить табличным тестом; для девяти будущих мутаций проверить отказ без подтверждения. В тесте `find_client` использовать известный телефон из `mock_backend.json`.

```python
def test_all_declared_actions_are_registered(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert set(actions.handlers) == set(catalog.actions)
```

- [ ] **Step 2: Проверить красный тест.** `uv run --project backend pytest backend/tests/test_actions.py -q` → FAIL из-за отсутствия `ActionEngine`.
- [ ] **Step 3: Реализовать реестр и обработчики по доменам.** `find_*`, `get_*`, `calc_*`, `kb_lookup`, `list_clinics`, `check_*` читают профиль/KB; коммуникационные действия создают записи в состоянии звонка. Для девяти действий с `irreversible=true` на этом этапе реестр возвращает `invalid_input` без мутации; они реализуются в задаче 3. Расчёты берут формулы из `knowledge_base.json`; ошибки и предусловия — из `actions.json`.

```python
spec = catalog.actions[name]
handler = self.handlers[name]
result = handler(inputs)
if "error" in result and result["error"]["code"] not in catalog.error_codes:
    raise ValueError(f"Undeclared action error: {name}")
return result
```

- [ ] **Step 4: Прогнать тесты и проверить, что ни один обработчик не пишет в `datas/*.json`.** `uv run --project backend pytest backend/tests/test_actions.py -q` → PASS.
- [ ] **Step 5: Коммит.** `git add backend/app/actions.py backend/tests/test_actions.py`; `git commit -m "feat: add mock backend actions"`.

## Task 3: Подтверждение и повторные вызовы

**Files:** Modify `backend/app/actions.py`; create `backend/tests/test_confirmation.py`.

**Interfaces:** `SessionActions.preview(name: str, inputs: dict) -> PendingAction` не меняет данные; `PendingAction` содержит `action_id`, `name`, `inputs`, `summary`. `SessionActions.call(name: str, inputs: dict, *, action_id: str | None = None, confirmed: bool = False) -> dict` сохраняет прежнюю сигнатуру; для необратимого действия требует `action_id` и `confirmed=True`, исполняет его один раз и запоминает результат.

- [ ] **Step 1: Написать `test_confirmation_is_required_and_idempotent`.** На `create_policy` проверить: preview не добавляет полис; `call` без согласия возвращает `invalid_input`; два `call` с одним `action_id` возвращают тот же ID и создают один полис. Таблично повторить preview/execute для всех девяти действий с `irreversible=true`; добавить тест отказа и изменения аргументов после preview.

```python
pending = actions.preview("create_policy", valid_inputs)
assert actions.count("policies") == original_count
first = actions.call("create_policy", valid_inputs, action_id=pending.action_id, confirmed=True)
second = actions.call("create_policy", valid_inputs, action_id=pending.action_id, confirmed=True)
assert first == second
assert actions.count("policies") == original_count + 1
```

- [ ] **Step 2: Запустить тест, увидеть FAIL.** `uv run --project backend pytest backend/tests/test_confirmation.py -q`.
- [ ] **Step 3: Реализовать журнал `action_id` внутри сессии и проверку `ActionSpec.irreversible`.** Перед записью сравнивать нормализованные аргументы с preview; отказ очищает preview. Девять действий с `irreversible=true` не должны выполняться через обходной путь.

```python
if spec.irreversible and (not confirmed or action_id not in self.pending):
    return {"error": {"code": "invalid_input", "message": "Explicit confirmation required"}}
if action_id in self.completed:
    return self.completed[action_id]
```

- [ ] **Step 4: Прогнать оба набора тестов действий.** `uv run --project backend pytest backend/tests/test_actions.py backend/tests/test_confirmation.py -q` → PASS.
- [ ] **Step 5: Коммит.** `git add backend/app/actions.py backend/tests/test_confirmation.py`; `git commit -m "feat: guard irreversible mock actions"`.

## Task 4: LLM-маршрутизатор и dev-оценка

**Files:** Create `backend/app/router.py`, `backend/tests/test_router.py`, `backend/scripts/evaluate_router.py`; modify `backend/app/domain.py`, `backend/pyproject.toml`.

**Interfaces:** `LLMRouter.route(text: str, context: RouterContext) -> RouterDecision` (async). `RouterDecision` содержит `language`, `scenarios: list[SelectedScenario]`, `alternatives`, `slots`, `is_continuation`, `needs_clarification`. `SelectedScenario` содержит `scenario_id`, `reason`, `confidence_estimate`; эта оценка не используется как доказанная вероятность.

- [ ] **Step 1: Написать тесты с fake structured model.** `test_router_distinguishes_car_claims` задаёт случаи SC11/SC12/SC13, `test_router_mixed_language` — казахскую фразу с русским фрагментом, плюс тест неизвестного ID и системного намерения. Промпт должен содержать правила `not_this_if` из каталога.

```python
decision = await router.route("Выплату одобрили, но сумма слишком мала", RouterContext.empty())
assert decision.scenarios[0].scenario_id == "SC19"
assert decision.language == "ru"
```

- [ ] **Step 2: Запустить тест и увидеть FAIL.** `uv run --project backend pytest backend/tests/test_router.py -q`.
- [ ] **Step 3: Реализовать LLM-вызов через `ChatOpenAI(model=settings.router_model, use_responses_api=True, reasoning_effort="low")` и `.with_structured_output(RouterDecision, method="json_schema")`.** Вынести prompt builder отдельно: компактные `description`, `not_this_if` и важные примеры всех 40 сценариев; ограниченный контекст звонка. Неверный ID, пустой ответ и таймаут превращать в явное решение об уточнении/передаче оператору.

```python
model = ChatOpenAI(model=settings.router_model, use_responses_api=True, reasoning_effort="low")
structured = model.with_structured_output(RouterDecision, method="json_schema")
decision = await structured.ainvoke(messages)
decision.validate_scenario_ids(catalog.scenarios, catalog.system_intents)
```

- [ ] **Step 4: Запустить тесты; при наличии `OPENAI_API_KEY` оценить две модели.** Скрипт пишет `predictions.json` в временный каталог, затем вызывает `datas/evaluate.py`; сравнить `gpt-6-sol` и `gpt-6-luna` по `ru`, `kk`, `mixed` и multi-intent, сохранить измерения и ошибки в `backend/README.md`. Команды: `uv run --project backend pytest backend/tests/test_router.py -q` и `uv run --project backend python backend/scripts/evaluate_router.py --model gpt-6-sol`.
- [ ] **Step 5: Коммит.** `git add backend/app/router.py backend/app/domain.py backend/tests/test_router.py backend/scripts/evaluate_router.py backend/pyproject.toml`; `git commit -m "feat: add LLM scenario router"`.

## Task 5: LangGraph и политика диалога

**Files:** Create `backend/app/graph.py`, `backend/app/reply.py`, `backend/tests/test_graph.py`; modify `backend/app/domain.py`.

**Interfaces:** `build_graph(catalog: Catalog, router: LLMRouter, action_engine: ActionEngine, checkpointer: InMemorySaver) -> CompiledStateGraph`; вход `CallState` с полями `session_id`, `turn_id`, `transcript`, `language`, `client_id`, `active_scenario`, `pending_scenarios`, `suspended_scenarios`, `slots`, `pending_confirmation`, `clarification_count`, `trace`, `timings`; `run_turn(graph, session_id: str, turn_id: str, text: str) -> TurnResult` (async) возвращает `text`, `language`, `route`, `actions`, `trace`, `pending_scenarios`. `thread_id=session_id`.

- [ ] **Step 1: Написать тесты переходов.** `test_urgent_multi_intent_keeps_queue` проверяет, что SC15 исполняется прежде SC33 и SC33 остаётся в очереди; тесты `SYS_UNCLEAR`, продолжения сбора слотов без вызова router, смены темы, отказа и подтверждения действия через `Command(resume="Иә, растаймын")`. Добавить нормализацию произнесённого телефона и относительной даты от `2026-10-01`, а также честный ответ на «Вы робот?».

```python
result = await run_turn(graph, "call-1", "turn-1", "Мне плохо за границей, и где ваш офис?")
assert result.route.scenarios[0].scenario_id == "SC15"
assert result.pending_scenarios == ["SC33"]
```

- [ ] **Step 2: Запустить тест и увидеть FAIL.** `uv run --project backend pytest backend/tests/test_graph.py -q`.
- [ ] **Step 3: Собрать `StateGraph` с узлами `ingest → route → policy → identify/collect_slots → act → confirm → execute_confirmed → respond`.** `run_turn` при ожидающем `interrupt` передаёт новую реплику в `Command(resume=text)`; при новом запросе передаёт обычный вход графу. `confirm` только прерывает граф, `execute_confirmed` находится в отдельном узле после возобновления. Слоты сверяются с `slots.json`, запрос недостающего слота задаёт один вопрос, ответ строится из шаблона/KB и результата действия. `reply.py` произносит числа словами, маскирует персональные значения при повторении и передаёт оператору краткое резюме. При двух неудачных уточнениях — handoff. После каждой реплики возвращать маршрут для трассировки с `source=llm|continuation|confirmation`, даже когда LLM не вызывалась.

```python
def confirm_node(state: CallState) -> dict:
    answer = interrupt({"action_id": state["pending_confirmation"]["action_id"]})
    return {"confirmation_answer": answer}

def execute_confirmed_node(state: CallState) -> dict:
    if normalize_yes(state["confirmation_answer"], state["language"]):
        return execute_pending_action(state)
    if normalize_no(state["confirmation_answer"], state["language"]):
        return {"pending_confirmation": None, "next_node": "respond"}
    return {"pending_confirmation": None, "transcript": state["confirmation_answer"], "next_node": "route"}
```

- [ ] **Step 4: Запустить все локальные тесты графа и действий.** `uv run --project backend pytest backend/tests/test_graph.py backend/tests/test_confirmation.py -q` → PASS.
- [ ] **Step 5: Коммит.** `git add backend/app/graph.py backend/app/reply.py backend/app/domain.py backend/tests/test_graph.py`; `git commit -m "feat: orchestrate conversations with LangGraph"`.

## Task 6: FastAPI, текстовый WebSocket и трассировка

**Files:** Create `backend/app/sessions.py`, `backend/app/api/__init__.py`, `backend/app/api/contracts.py`, `backend/app/api/http.py`, `backend/app/api/ws.py`, `backend/app/main.py`, `backend/tests/test_api.py`.

**Interfaces:** HTTP и события WS в точности соответствуют [frontend.md](../../../frontend/docs/frontend.md). `SessionManager.create() -> Session`, `get(session_id) -> Session | None`, `process_text(session_id, turn_id, text) -> TurnResult`; session хранит `last_seq`, обработанные `turn_id` и локальную копию мок-бэкенда.

- [ ] **Step 1: Написать контрактные тесты FastAPI.** Проверить `/health`, создание/чтение сессии, каталог, `session.ready`, `turn.text` → `transcript.final`/`route.decision`/`agent.text`/`trace.updated`/`turn.complete`, а также неизвестную сессию и повтор `turn_id`.

```python
def test_text_turn_emits_answer(client):
    session = client.post("/api/v1/sessions", json={}).json()
    with client.websocket_connect(session["ws_path"]) as ws:
        assert ws.receive_json()["type"] == "session.ready"
        ws.send_json({"type": "turn.text", "turn_id": "turn-1", "payload": {"text": "Где офис?"}})
        assert ws.receive_json()["type"] == "transcript.final"
```

- [ ] **Step 2: Запустить тест и увидеть FAIL.** `uv run --project backend pytest backend/tests/test_api.py -q`.
- [ ] **Step 3: Реализовать маршруты и типы `ClientEvent`/`ServerEvent`.** `ServerEvent` содержит `type`, `turn_id`, `seq`, `payload`; `ClientEvent` проверяет обязательный `turn_id` для `turn.text`, `turn.start` и `turn.commit`. `GET /sessions/{id}` возвращает `session_id`, `last_seq`, `last_turn_id`, `active_scenario`, безопасное резюме `pending_confirmation`, `last_trace`. Перед отправкой события маскировать телефон, ИИН и email в повторно озвученных данных и аргументах действий. WebSocket принимает JSON и бинарные кадры, но до задачи 7 аудио возвращает `error.code="invalid_event"`. Проверять origin и конфигурируемый CORS; логировать `turn_id`, не сырые персональные значения.

```python
@app.websocket("/api/v1/sessions/{session_id}/stream")
async def stream(websocket: WebSocket, session_id: str):
    session = sessions.get(session_id)
    if session is None:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    await websocket.send_json(session.next_event("session.ready", None, {"session_id": session_id}))
```

- [ ] **Step 4: Прогнать API-тесты и ручной текстовый сценарий через WebSocket.** `uv run --project backend pytest backend/tests/test_api.py -q` → PASS; OpenAPI показывает HTTP-маршруты.
- [ ] **Step 5: Коммит.** `git add backend/app/sessions.py backend/app/api backend/app/main.py backend/tests/test_api.py`; `git commit -m "feat: expose Voice Router API"`.

## Task 7: Потоковое STT/TTS и бинарный WebSocket

**Files:** Create `backend/app/audio/__init__.py`, `backend/app/audio/stt.py`, `backend/app/audio/tts.py`, `backend/tests/test_audio.py`; modify `backend/app/api/ws.py`, `backend/tests/test_api.py`.

**Interfaces:** `Transcriber.feed(pcm: bytes) -> None`, `Transcriber.finish() -> str` и поток частичных строк; `Synthesizer.stream(text: str, language: str) -> AsyncIterator[bytes]`. Фронт отправляет PCM16 mono 24 kHz между `turn.start` и `turn.commit`; сервер посылает `audio.start`, бинарные PCM-кадры, `audio.end`.

- [ ] **Step 1: Написать тесты fake STT/TTS и WebSocket.** Проверить, что STT запускает граф только после `turn.commit`, `transcript.partial` не запускает действие, первый бинарный кадр следует после `audio.start`, а ошибка TTS оставляет `agent.text`. `test_duplicate_turn_and_tts_failure` проверяет, что повтор `turn_id` не делает второй вызов router.

```python
def test_duplicate_turn_and_tts_failure(client_with_fakes):
    events = send_audio_turn(client_with_fakes, turn_id="same-id", pcm=b"\x00\x00" * 2400)
    assert any(e["type"] == "agent.text" for e in events)
    assert any(e["payload"].get("code") == "tts_unavailable" for e in events if e["type"] == "error")
    send_audio_turn(client_with_fakes, turn_id="same-id", pcm=b"\x00\x00" * 2400)
    assert client_with_fakes.router.calls == 1
```

- [ ] **Step 2: Запустить тест и увидеть FAIL.** `uv run --project backend pytest backend/tests/test_audio.py backend/tests/test_api.py -q`.
- [ ] **Step 3: Реализовать серверный мост к `gpt-live-transcribe` и потоковый `gpt-4o-mini-tts` в PCM.** На `turn.commit` отправлять upstream commit и ждать финальный транскрипт; сопоставлять upstream `item_id` с репликой. Разделить чтение WS и отправку событий на две async-задачи с одной очередью вывода, чтобы `playback.started` принимался во время TTS. Использовать таймауты и текстовый fallback. В `trace.updated` отдельно отражать серверное время до первой отправленной аудиопорции и `client_first_audio_ms` из `playback.started`.

```python
await websocket.send_json(session.next_event("audio.start", turn_id, AUDIO_FORMAT))
async for chunk in synthesizer.stream(reply.text, reply.language):
    await websocket.send_bytes(chunk)
await websocket.send_json(session.next_event("audio.end", turn_id, {}))
```

- [ ] **Step 4: Прогнать fake-тесты и вручную проверить живые `ru`, `kk`, `mixed` фразы.** `uv run --project backend pytest backend/tests/test_audio.py backend/tests/test_api.py -q` → PASS; сохранять только метрики и обезличенную трассировку.
- [ ] **Step 5: Коммит.** `git add backend/app/audio backend/app/api/ws.py backend/tests/test_audio.py backend/tests/test_api.py`; `git commit -m "feat: stream voice turns"`.

## Task 8: Сквозная проверка и запуск одной командой

**Files:** Create `backend/tests/test_dialogs.py`, `backend/README.md`; modify root `README.md`, `backend/pyproject.toml` при необходимости.

**Interfaces:** `uv run --project backend uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000` запускает API из корня репозитория. README перечисляет переменные `OPENAI_API_KEY`, `ROUTER_MODEL`, `FRONTEND_ORIGIN`, `DATA_DIR` и пример текстового WS-цикла.

- [ ] **Step 1: Написать сквозные тесты по `dialogs_sample.json`.** Проверить идентификацию по телефону, смену темы и возврат, смешанный язык, preview/execute, неясный запрос и перевод оператору; провайдеры заменены fake-адаптерами, данные берутся из стартового набора.

```python
def test_confirmation_flow_uses_mock_backend(dialog_runner):
    result = dialog_runner.run("D07")
    assert result.preview_before_execute
    assert result.executed_after_explicit_yes
    assert result.executions == 1
```

- [ ] **Step 2: Убедиться, что тесты сначала выявляют недостающие переходы.** `uv run --project backend pytest backend/tests/test_dialogs.py -q`.
- [ ] **Step 3: Исправить обнаруженные переходы, документировать запуск и контракт.** README показывает установку через `uv sync --project backend`, команду запуска, ссылку на `frontend/docs/frontend.md`, ограничения памяти и дату среза; конфигурация не пишет в `datas/`.

```bash
uv sync --project backend
uv run --project backend uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
uv run --project backend pytest backend/tests -q
```

- [ ] **Step 4: Прогнать полный набор и оценку маршрутизатора.** `uv run --project backend pytest backend/tests -q`; при доступном API-ключе — `uv run --project backend python backend/scripts/evaluate_router.py --model gpt-6-sol`. Зафиксировать точность и p50 задержки живых голосовых реплик как фактические результаты, а не плановые значения.
- [ ] **Step 5: Коммит.** `git add backend/tests/test_dialogs.py backend/README.md README.md backend/pyproject.toml backend/app`; `git commit -m "docs: make Voice Router backend reproducible"`.

## Граница этого плана

Это бэкенд-план и контракт для фронта. Реализация React-интерфейса, развёртывание с несколькими процессами, постоянное хранилище и JEV-fast-path остаются отдельными последующими задачами. В первой версии выигрыш от дополнительного роутера не должен усложнять основной LLM-маршрут.

Источники по API: [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/), [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [LangChain OpenAI reference](https://reference.langchain.com/python/langchain-openai/langchain_openai), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech).
