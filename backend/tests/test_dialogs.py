"""Sample-dialogue checks with the real catalog, action engine, and graph.

Only the external language model is replaced by the sample's annotated routes.
The assertions concern graph state and action effects, not scripted bot prose.
"""

import json
from copy import deepcopy
from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from app.actions import ActionEngine
from app.catalog import Catalog
from app.graph import build_graph, run_turn
from app.router import RouterDecision, SelectedScenario


DATA_DIR = Path(__file__).resolve().parents[2] / "datas"


def sample(dialog_id):
    dialogs = json.loads((DATA_DIR / "dialogs_sample.json").read_text())["dialogs"]
    return next(dialog for dialog in dialogs if dialog["dialog_id"] == dialog_id)


def client_turns(dialog_id):
    return [turn for turn in sample(dialog_id)["turns"] if turn["role"] == "client"]


def annotated_route(turn):
    return RouterDecision(
        language="kk" if turn["lang"] in {"kk", "mixed"} else "ru",
        scenarios=[SelectedScenario(scenario_id=sid, reason="Sample annotation", confidence_estimate=None)
                   for sid in turn["scenarios"]],
        alternatives=[],
        slots=turn["slots"],
        is_continuation=False,
        needs_clarification="SYS_UNCLEAR" in turn["scenarios"],
    )


class SampleRouter:
    def __init__(self, *turns):
        self.decisions = [annotated_route(turn) for turn in turns]
        self.calls = []

    async def route(self, text, context):
        assert self.decisions, f"Unexpected model call for {text!r}"
        self.calls.append((text, context))
        return self.decisions.pop(0)


class CapturingEngine(ActionEngine):
    def __init__(self, catalog):
        super().__init__(catalog)
        self.sessions = {}

    def new_session(self, session_id):
        session = super().new_session(session_id)
        self.sessions[session_id] = session
        return session


def dialogue_graph(*route_turns):
    catalog = Catalog.load(DATA_DIR)
    router = SampleRouter(*route_turns)
    engine = CapturingEngine(catalog)
    return build_graph(catalog, router, engine, InMemorySaver()), router, engine


@pytest.mark.asyncio
async def test_sample_unclear_request_asks_before_routing_resend():
    first, second, _ = client_turns("D05")
    graph, router, _ = dialogue_graph(first, second)
    unclear = await run_turn(graph, "D05", "1", first["text"])
    assert unclear.status == "clarifying"
    assert unclear.route.scenarios[0].scenario_id == "SYS_UNCLEAR"
    resend = await run_turn(graph, "D05", "2", second["text"])
    assert resend.route.scenarios[0].scenario_id == "SC26"
    assert resend.status == "collecting_slots"
    assert len(router.calls) == 2


@pytest.mark.asyncio
async def test_repeated_sample_unclear_request_hands_off_to_operator():
    unclear = client_turns("D05")[0]
    graph, router, engine = dialogue_graph(unclear, unclear, unclear)
    results = [await run_turn(graph, "D05-unclear", str(turn_id), unclear["text"])
               for turn_id in range(1, 4)]
    assert [result.status for result in results] == ["clarifying", "clarifying", "handoff"]
    assert engine.sessions["D05-unclear"].state["transfers"][-1]["queue"] == "operator_general"
    assert len(router.calls) == 3


@pytest.mark.asyncio
async def test_sample_topic_switch_preserves_original_question():
    first, _, detour, back, _ = client_turns("D03")
    graph, router, _ = dialogue_graph(first, detour, back)
    initial = await run_turn(graph, "D03", "1", first["text"])
    assert initial.status == "collecting_slots"
    detoured = await run_turn(graph, "D03", "2", detour["text"])
    assert detoured.route.scenarios[0].scenario_id == "SC27"
    assert "SC31" in detoured.pending_scenarios
    state = (await graph.aget_state({"configurable": {"thread_id": "D03"}})).values
    assert state["suspended_scenarios"][-1]["active_scenario"] == "SC17"
    returned = await run_turn(graph, "D03", "3", back["text"])
    assert returned.route.scenarios[0].scenario_id == "SC18"
    assert len(router.calls) == 3


@pytest.mark.asyncio
async def test_sample_mixed_language_keeps_kazakh_response_language():
    first = client_turns("D04")[0]
    graph, router, _ = dialogue_graph(first)
    result = await run_turn(graph, "D04", "1", first["text"])
    assert result.route.scenarios[0].scenario_id == "SC21"
    assert result.language == "kk"
    assert result.status == "collecting_slots"
    assert len(router.calls) == 1


@pytest.mark.asyncio
async def test_sample_phone_identifies_client_for_resend():
    first, second, phone = client_turns("D05")
    graph, router, _ = dialogue_graph(first, second)
    await run_turn(graph, "D05-phone", "1", first["text"])
    await run_turn(graph, "D05-phone", "2", second["text"])
    result = await run_turn(graph, "D05-phone", "3", phone["text"])
    state = (await graph.aget_state({"configurable": {"thread_id": "D05-phone"}})).values
    assert state["client_id"] == sample("D05")["client_id"]
    assert result.route.source == "continuation"
    assert any(action["name"] == "find_client" for action in result.actions)
    assert len(router.calls) == 2


@pytest.mark.asyncio
async def test_sample_cancellation_previews_then_executes_after_explicit_yes():
    request, phone, yes = client_turns("D07")
    graph, router, engine = dialogue_graph(request)
    first = await run_turn(graph, "D07", "1", request["text"])
    assert first.status == "collecting_slots"
    before = deepcopy(engine.sessions["D07"].state["policies"])
    preview = await run_turn(graph, "D07", "2", phone["text"])
    assert preview.status == "awaiting_confirmation"
    assert preview.pending_confirmation["name"] == "cancel_policy"
    assert engine.sessions["D07"].state["policies"] == before
    executed = await run_turn(graph, "D07", "3", yes["text"])
    assert executed.route.source == "confirmation"
    assert sum(action["name"] == "cancel_policy" and action["status"] == "completed"
               for action in executed.actions) == 1
    assert engine.sessions["D07"].state["policies"] != before
    assert len(router.calls) == 1
