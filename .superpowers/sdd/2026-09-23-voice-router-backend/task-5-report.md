# Task 5 — LangGraph dialogue and policy

Status: implemented and verified in `feat/voice-router-graph`.

## Delivered

- `backend/app/graph.py`: real compiled `StateGraph` with ingest, route, policy, identify, collect_slots, act, confirm, execute_confirmed and respond nodes. `InMemorySaver` uses `thread_id=session_id`.
- Graph owns a lazy per-session `SessionActions` instance. APIs need only `build_graph(...)` and `await run_turn(graph, session_id, turn_id, text)`.
- Irreversible preview is saved in `act`; `confirm` only calls `interrupt`. `execute_confirmed` is a distinct downstream node. Initial paused invocation returns visible preview text, action ID and awaiting-confirmation status.
- Confirmation uses a closed Russian/Kazakh yes/no vocabulary. Qualified consent is never executed. New-topic responses discard the pending action. Returning to an interrupted confirmation creates a new preview ID and requires fresh consent.
- Urgent intent ordering preserves the pending queue. Slot answers continue without the LLM. Topic switches save the current scenario's slots, facts and execution position, and completion offers a return.
- Catalog validation converts slots to native types and records each value's source and owning scenario. One missing slot is requested per turn. Phone normalization supports digits, formatted numbers, and spoken individual Russian/Kazakh digits; relative dates use the dataset's `2026-10-01` reference date.
- Identification uses supported phone/IIN, policy and claim lookups. Missing identifiers and missing action inputs become a slot prompt or safe operator transfer.
- The first SYS_UNCLEAR response asks a question; two further unresolved clarification answers transfer to an operator with a masked short summary. Two invalid answers to a known slot likewise transfer.
- `reply.py`: masked personal identifiers/contact values, RU/KK number speech, bilingual confirmation action labels, honest AI identity reply, and concise localized common KB summaries. Template placeholders never escape to the spoken output.
- Per-turn routing trace always reports `source=llm|continuation|confirmation`. Upstream optional `routing_error` is copied to the route trace using `getattr` for backward compatibility.
- Quoted premium is carried into the confirmed create-policy inputs; vehicle type is requested rather than assumed when absent.

## Contract

`TurnResult` and `TurnRoute` are Pydantic models in `app.domain`.

`TurnResult`: session_id, turn_id, text, language, route, actions, trace, pending_scenarios, pending_confirmation, status, timings.

Statuses: completed, collecting_slots, awaiting_confirmation, clarifying, handoff.

Actions are per-turn dictionaries with name, inputs, result and status (completed/preview/error). `TurnRoute` has all public router fields plus source. Each selected scenario exposes `.scenario_id`, `.reason`, `.confidence_estimate`.

## Verification

TDD RED observed before implementation: 17 failures due to missing graph/reply modules. Subsequent integration RED cases caught confirmation rerouting marker misuse, resumed-confirmation execution position, personal-address leakage, missing issued-policy premium, assumed vehicle class, missing Kazakh KB response and English confirmation titles; all corrected.

Final verification: `uv run --project backend pytest -q` — **165 passed**, including **26 graph tests**, in 2.56 seconds. `git diff --check` passed. Graph + guarded-action targeted run also passed earlier (43 tests at that point).

Tests use the real catalog, ActionEngine, compiled LangGraph and in-memory checkpointing. The only replaced external dependency is the LLM router. Direct `Command(resume="Иә, растаймын")` and the public run_turn confirmation path are both exercised. No live APIs or `.env` files were used.

LangGraph documentation checked through Context7: `/langchain-ai/langgraph`, StateGraph/InMemorySaver, interrupt replay and Command(resume), async state inspection.

## Limits / integration notes

- In-memory checkpoint and action state last only for the lifetime of the compiled graph instance, as required by this prototype. API must retain the graph and serialize concurrent turns for the same session.
- Free-form topic-switch detection recognizes interruption/question cues; this is not a second business-intent router. Unmarked text that fits a free-text slot is treated as an answer to that slot.
- Numeric speech renders integer groups, rather than grammatical date declension. Spoken phone normalization currently targets individual digits, not arbitrary colloquial grouped numbers.
- Catalog KB is mostly English. Common information scenarios have concise local summaries; arbitrary KB topics can still expose English fact strings in the localized outer template. Broader bilingual KB authoring is outside these owned files and should be considered before a full production dialogue evaluation.
- This branch predates upstream action/router review fixes. No conflict is expected: existing public APIs are used; manual_quote_required results route safely to an operator and optional routing_error is traced.

## Review fixes (2026-09-23)

- Added five regressions before implementation. Four focused tests failed as expected: queued SC36 slots were lost, an SC15 switch was consumed as SC28 cancel_reason, a D07 phone answer did not identify the unique policy, and TurnRoute discarded routing_error. A fifth test confirmed the sample D05 formatted phone with a final period was rejected before the normalizer change.
- Queued scenarios now retain separately validated slot snapshots, including source and owning scenario. Resuming SC36 after SC33 uses the supplied phone and callback time without prompting again.
- Free-text slots route through the LLM with the pending question and recent turns; structured slot answers retain the direct continuation path. The graph no longer treats an arbitrary free-text utterance as a cancellation reason without routing.
- A labelled phone answer to a policy-number question is normalized and identifies the client. If that client has exactly one active policy, the graph fills the policy number from get_policies; if several are active, it continues asking for the number. The exact D07 Kazakh grouped phone and D05 formatted Russian phone samples normalize to +77010000010 and +77010000009.
- TurnRoute exposes optional routing_error. The route trace still carries it for compatibility with older router objects.
- Final verification in this worktree: `uv run --project backend pytest -q` — **170 passed** in 2.76 seconds. `git diff --check` passed. The branch still predates upstream router/action integration; integration tests should be rerun after cherry-picking.
