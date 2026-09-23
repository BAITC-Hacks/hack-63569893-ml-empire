"""Dialogue contracts: real graph/catalog/actions; only the external router is fake."""

from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from app.actions import ActionEngine
from app.catalog import Catalog
from app.router import RouterDecision, SelectedScenario


class ScriptedRouter:
    def __init__(self, *decisions):
        self.decisions = list(decisions)

    async def route(self, text, context):
        assert self.decisions, "Unexpected reroute of a slot answer or confirmation"
        return self.decisions.pop(0)


class CapturingEngine(ActionEngine):
    def new_session(self, session_id):
        session = super().new_session(session_id)
        self.sessions[session_id] = session
        return session


def decision(*ids, language="ru", **slots):
    return RouterDecision(language=language, scenarios=[SelectedScenario(
        scenario_id=i, reason="Explicit test request", confidence_estimate=0.9
    ) for i in ids], alternatives=[], slots=slots, is_continuation=False,
        needs_clarification="SYS_UNCLEAR" in ids)


@pytest.fixture
def setup_graph():
    def setup(*decisions):
        from app.graph import build_graph
        catalog = Catalog.load(Path(__file__).resolve().parents[2] / "datas")
        engine = CapturingEngine(catalog)
        engine.sessions = {}
        graph = build_graph(catalog, ScriptedRouter(*decisions), engine, InMemorySaver())
        return graph, engine
    return setup


@pytest.mark.asyncio
async def test_urgent_multi_intent_keeps_queue(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC33", "SC15"))
    result = await run_turn(graph, "call-1", "turn-1", "Мне плохо за границей, и где ваш офис?")
    assert result.route.scenarios[0].scenario_id == "SC15"
    assert result.pending_scenarios == ["SC33"]
    assert result.status == "collecting_slots"
    assert result.text.count("?") <= 1


@pytest.mark.asyncio
async def test_queued_scenarios_keep_their_own_supplied_slots(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC33", "SC36", city="Almaty", phone="+77010000001", callback_time="завтра"))
    first = await run_turn(graph, "queued", "1", "Где офис в Алматы? Перезвоните завтра на +77010000001")
    assert first.status == "completed"
    assert first.pending_scenarios == ["SC36"]
    resumed = await run_turn(graph, "queued", "2", "Да")
    assert resumed.status == "completed"
    assert resumed.route.scenarios[0].scenario_id == "SC36"
    assert engine.sessions["queued"].state["callbacks"][-1]["phone"] == "+77010000001"


@pytest.mark.asyncio
async def test_free_text_slot_answer_can_switch_to_urgent_intent(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501"), decision("SC15", location="Turkey", incident_description="Fever"))
    first = await run_turn(graph, "switch", "1", "Расторгнуть полис")
    assert first.status == "collecting_slots"
    second = await run_turn(graph, "switch", "2", "Мне плохо за границей")
    assert second.route.source == "llm"
    assert second.route.scenarios[0].scenario_id == "SC15"
    assert second.status == "collecting_slots"
    state = (await graph.aget_state({"configurable": {"thread_id": "switch"}})).values
    assert state["active_scenario"] == "SC15"
    assert state["suspended_scenarios"][-1]["active_scenario"] == "SC28"


@pytest.mark.asyncio
async def test_phone_identifies_unique_active_policy_for_cancellation(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", language="kk", cancel_reason="Car sold"))
    first = await run_turn(graph, "unique", "1", "Көлікті саттым, шартты бұзғым келеді")
    assert first.status == "collecting_slots"
    preview = await run_turn(graph, "unique", "2", "Телефон: плюс жеті, жеті жүз бір, нөл нөл нөл, нөл нөл, он.")
    assert preview.status == "awaiting_confirmation"
    assert preview.pending_confirmation["inputs"]["policy_number"] == "SQ-CASCO-204350"
    assert not engine.sessions["unique"].completed


@pytest.mark.asyncio
async def test_ambiguous_client_policies_still_ask_for_policy_number(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC28", cancel_reason="Car sold"))
    await run_turn(graph, "ambiguous", "1", "Расторгнуть полис")
    result = await run_turn(graph, "ambiguous", "2", "Телефон: +77010000001")
    assert result.status == "collecting_slots"
    assert result.pending_confirmation is None
    state = (await graph.aget_state({"configurable": {"thread_id": "ambiguous"}})).values
    assert state["expected_slot"] == "policy_number"


@pytest.mark.asyncio
async def test_router_error_survives_public_turn_route(setup_graph):
    from app.graph import run_turn
    from types import SimpleNamespace
    routed = decision("SYS_UNCLEAR")
    routed = SimpleNamespace(language="ru", routing_error="router_unavailable",
                             model_dump=lambda: {**routed.model_dump_base, "routing_error": "router_unavailable"},
                             model_dump_base=routed.model_dump())
    graph, _ = setup_graph(routed)
    result = await run_turn(graph, "error", "1", "Не знаю")
    assert result.route.routing_error == "router_unavailable"


@pytest.mark.asyncio
async def test_city_answer_continues_without_reroute(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC33"))
    first = await run_turn(graph, "call", "1", "Где ваш офис?")
    assert first.status == "collecting_slots"
    result = await run_turn(graph, "call", "2", "Алматы")
    assert result.route.source == "continuation"
    assert any(a["name"] == "get_offices" and "address" in a["result"] for a in result.actions)
    assert "{" not in result.text


@pytest.mark.asyncio
async def test_switch_and_resume_preserve_original_slots(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501"), decision("SC33", city="Almaty"))
    await run_turn(graph, "call", "1", "Хочу расторгнуть полис")
    changed = await run_turn(graph, "call", "2", "А где ваш офис в Алматы?")
    assert changed.route.scenarios[0].scenario_id == "SC33"
    assert "верн" in changed.text.lower()
    resumed = await run_turn(graph, "call", "3", "Да, вернёмся")
    assert resumed.route.source == "continuation"
    assert resumed.route.scenarios[0].scenario_id == "SC28"
    state = (await graph.aget_state({"configurable": {"thread_id": "call"}})).values
    assert state["slots"]["policy_number"]["value"] == "SQ-OGPO-104501"


@pytest.mark.asyncio
async def test_preview_pauses_before_side_effect_and_direct_command_confirms(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", language="kk", policy_number="SQ-OGPO-104501", cancel_reason="Sold vehicle"))
    result = await run_turn(graph, "call", "1", "Полисті тоқтату")
    assert result.status == "awaiting_confirmation"
    assert result.text and "104501" not in result.text
    session = engine.sessions["call"]
    assert session.call("get_policy", {"policy_number": "SQ-OGPO-104501"})["status"] == "active"
    config = {"configurable": {"thread_id": "call"}}
    snapshot = await graph.aget_state(config)
    assert snapshot.next == ("confirm",)
    await graph.ainvoke(Command(resume="Иә, растаймын"), config)
    assert session.call("get_policy", {"policy_number": "SQ-OGPO-104501"})["status"] == "cancelled"
    assert len(session.completed) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["Да, подтверждаю", "Иә, растаймын"])
async def test_run_turn_resumes_confirmation(setup_graph, answer):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501", cancel_reason="Sold vehicle"))
    await run_turn(graph, "call", "1", "Расторгнуть")
    result = await run_turn(graph, "call", "2", answer)
    assert result.route.source == "confirmation"
    assert result.turn_id == "2"
    assert result.pending_confirmation is None
    assert any(a["name"] == "cancel_policy" and "refund_amount" in a["result"] for a in result.actions)
    assert len(engine.sessions["call"].completed) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["Нет", "Жоқ", "Да, но не отменяйте", "Иә, бірақ тоқтатпаңыз"])
async def test_refusal_or_qualified_yes_never_executes(setup_graph, answer):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501", cancel_reason="Sold vehicle"), decision("SYS_UNCLEAR"))
    await run_turn(graph, "call", "1", "Расторгнуть")
    result = await run_turn(graph, "call", "2", answer)
    assert not engine.sessions["call"].completed
    assert result.pending_confirmation is None


@pytest.mark.asyncio
async def test_new_topic_cancels_confirmation_and_routes(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501", cancel_reason="Sold vehicle"), decision("SC33", city="Almaty"))
    await run_turn(graph, "call", "1", "Расторгнуть")
    result = await run_turn(graph, "call", "2", "Лучше скажите адрес офиса")
    assert result.route.source == "llm"
    assert result.route.scenarios[0].scenario_id == "SC33"
    assert not engine.sessions["call"].pending
    assert not engine.sessions["call"].completed


@pytest.mark.asyncio
async def test_two_failed_clarifications_handoff_with_summary(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(*(decision("SYS_UNCLEAR") for _ in range(3)))
    first = await run_turn(graph, "call", "1", "Ну это")
    assert first.status == "clarifying"
    await run_turn(graph, "call", "2", "Не знаю")
    last = await run_turn(graph, "call", "3", "Как-то так")
    assert last.status == "handoff"
    transfer = engine.sessions["call"].state["transfers"][-1]
    assert transfer["queue"] == "operator_general"
    assert transfer["summary"]


@pytest.mark.asyncio
async def test_spoken_phone_and_relative_date_normalized(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC36", callback_time="завтра"))
    await run_turn(graph, "call", "1", "Перезвоните завтра")
    result = await run_turn(graph, "call", "2", "плюс семь семь ноль один ноль ноль ноль ноль ноль ноль один")
    assert result.status == "completed"
    assert engine.sessions["call"].state["callbacks"][-1]["phone"] == "+77010000001"
    from app.reply import normalize_slot
    catalog = Catalog.load(Path(__file__).resolve().parents[2] / "datas")
    assert normalize_slot("preferred_date", "завтра", catalog, "2026-10-01") == "2026-10-02"
    assert normalize_slot("incident_date", "вчера", catalog, "2026-10-01") == "2026-09-30"
    assert normalize_slot("preferred_date", "ертең", catalog, "2026-10-01") == "2026-10-02"
    assert normalize_slot("phone", "Плюс 7 701 000 00 09.", catalog, "2026-10-01") == "+77010000009"


@pytest.mark.asyncio
async def test_ai_identity_is_honest_and_does_not_call_router(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph()
    result = await run_turn(graph, "call", "1", "Вы робот?")
    assert "виртуальн" in result.text.lower() or "искусственн" in result.text.lower()
    assert result.route.source == "continuation"


@pytest.mark.asyncio
async def test_invalid_slot_is_not_used_and_only_one_question_asked(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", policy_number="not-a-policy"))
    result = await run_turn(graph, "call", "1", "Расторгнуть")
    assert result.status == "collecting_slots"
    assert result.text.count("?") <= 1
    assert not engine.sessions["call"].pending


def test_reply_masks_identifiers_and_speaks_numbers():
    from app.reply import render_text
    result = render_text("Телефон +77010000001, ИИН 850314300121, полис SQ-OGPO-104501, цена 1200 тенге.", "ru")
    assert "+77010000001" not in result
    assert "850314300121" not in result
    assert "104501" not in result
    assert "тысяча двести" in result


@pytest.mark.asyncio
async def test_calls_have_isolated_state(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC33"), decision("SC36"))
    await run_turn(graph, "A", "1", "Офис")
    await run_turn(graph, "B", "1", "Перезвоните")
    result = await run_turn(graph, "A", "2", "Алматы")
    assert result.route.scenarios[0].scenario_id == "SC33"
    assert result.status == "completed"


@pytest.mark.asyncio
async def test_returning_to_interrupted_confirmation_requires_fresh_consent(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC28", policy_number="SQ-OGPO-104501", cancel_reason="Sold vehicle"), decision("SC33", city="Almaty"))
    first = await run_turn(graph, "call", "1", "Расторгнуть")
    await run_turn(graph, "call", "2", "Где офис?")
    resumed = await run_turn(graph, "call", "3", "Да, вернёмся")
    assert resumed.status == "awaiting_confirmation"
    assert resumed.pending_confirmation["action_id"] != first.pending_confirmation["action_id"]
    assert not engine.sessions["call"].completed
    confirmed = await run_turn(graph, "call", "4", "Да")
    assert any(a["name"] == "cancel_policy" and "refund_amount" in a["result"] for a in confirmed.actions)


@pytest.mark.asyncio
async def test_urgent_handoff_preserves_secondary_intent(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC33", "SC15", policy_number="SQ-TRVL-304552", location="Turkey", incident_description="Fever"))
    result = await run_turn(graph, "call", "1", "Мне плохо и нужен адрес офиса")
    assert result.status == "handoff"
    assert result.pending_scenarios == ["SC33"]
    assert engine.sessions["call"].state["transfers"][-1]["queue"] == "medical_assistance_24_7"


@pytest.mark.asyncio
async def test_victim_claim_uses_culprit_policy_in_preview_and_execution(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC12", culprit_vehicle_plate="101AAA02",
                                         incident_date="2026-09-28", incident_description="Rear-end collision",
                                         phone="+77010000005"))
    preview = await run_turn(graph, "victim", "1", "Заявление по ДТП с 101AAA02")
    assert preview.status == "awaiting_confirmation"
    assert preview.pending_confirmation["inputs"]["policy_number"] == "SQ-OGPO-103990"
    assert engine.sessions["victim"].count("claims") == 4

    confirmed = await run_turn(graph, "victim", "2", "Да, подтверждаю")
    assert confirmed.status == "completed"
    claim = engine.sessions["victim"].state["claims"][-1]
    assert claim["policy_number"] == "SQ-OGPO-103990"
    assert claim["client_id"] == "C008"


@pytest.mark.asyncio
async def test_victim_claim_with_expired_culprit_policy_never_previews_or_creates_another_claim(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC12", culprit_vehicle_plate="222ABC17",
                                         incident_date="2026-09-28", incident_description="Rear-end collision",
                                         phone="+77010000005"))
    result = await run_turn(graph, "expired-culprit", "1", "Заявление по ДТП с 222ABC17")
    assert result.status == "handoff"
    assert result.pending_confirmation is None
    assert engine.sessions["expired-culprit"].count("claims") == 4
    assert not engine.sessions["expired-culprit"].pending
    assert engine.sessions["expired-culprit"].state["transfers"]


@pytest.mark.asyncio
async def test_slot_continuation_preserves_previous_action_facts(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC06", trip_country="Turkey", trip_start="2026-10-02", trip_end="2026-10-05", travelers_count="1", traveler_max_age="30"))
    result = await run_turn(graph, "call", "1", "Страховка в Турцию")
    assert result.status == "collecting_slots"
    preview = await run_turn(graph, "call", "2", "+77010000001")
    assert preview.status == "awaiting_confirmation"
    assert engine.sessions["call"].count("policies") == 11
    completed = await run_turn(graph, "call", "3", "Да")
    assert completed.status == "completed"
    assert engine.sessions["call"].count("policies") == 12
    facts = (await graph.aget_state({"configurable": {"thread_id": "call"}})).values["facts"]
    assert "price" in facts
    assert engine.sessions["call"].state["policies"][-1]["premium"] == facts["price"]


@pytest.mark.asyncio
async def test_two_invalid_slot_answers_handoff(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC33"))
    await run_turn(graph, "call", "1", "Офис")
    await run_turn(graph, "call", "2", "???")
    result = await run_turn(graph, "call", "3", "Не помню")
    assert result.status == "handoff"


def test_confirmation_masks_new_personal_address():
    from app.reply import confirmation_text
    from types import SimpleNamespace
    text = confirmation_text(SimpleNamespace(name="Изменить контакт"), {"inputs": {
        "contact_field": "address", "new_value": "Алматы, Сатпаева 12, квартира 45"}}, "ru")
    assert "Сатпаева" not in text


@pytest.mark.asyncio
async def test_issuance_asks_vehicle_type_before_pricing(setup_graph):
    from app.graph import run_turn
    graph, engine = setup_graph(decision("SC02", vehicle_plate="123ABC02", drivers_iin="850314300121", phone="+77010000001"))
    result = await run_turn(graph, "call", "1", "Оформить полис")
    assert result.status == "collecting_slots"
    assert not engine.sessions["call"].pending
    result = await run_turn(graph, "call", "2", "легковая")
    assert result.status == "awaiting_confirmation"
    assert result.pending_confirmation["inputs"]["price"] == 30400


@pytest.mark.asyncio
async def test_medical_information_is_short_and_in_selected_language(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC09", language="kk"))
    result = await run_turn(graph, "call", "1", "ДМС туралы")
    assert len(result.text) < 450
    assert "{" not in result.text
    assert "теңге" in result.text


@pytest.mark.asyncio
async def test_confirmation_names_action_in_selected_language(setup_graph):
    from app.graph import run_turn
    graph, _ = setup_graph(decision("SC28", language="kk", policy_number="SQ-OGPO-104501", cancel_reason="Көлікті саттым"))
    result = await run_turn(graph, "call", "1", "Полисті тоқтату")
    assert "бұзу" in result.text
    assert "Policy termination" not in result.text


def test_yes_to_vehicle_type_question_means_car():
    from app.reply import normalize_slot
    catalog = Catalog.load(Path(__file__).resolve().parents[2] / "datas")
    assert normalize_slot("vehicle_type", "да", catalog, "2026-10-01") == "car"
    assert normalize_slot("vehicle_type", "иә", catalog, "2026-10-01") == "car"
