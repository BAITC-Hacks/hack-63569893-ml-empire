import asyncio
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.catalog import Catalog
from app.router import LLMRouter, RouterContext
from scripts.evaluate_router import evaluate


DATA_DIR = Path(__file__).parents[2] / "datas"


class FakeStructuredModel:
    def __init__(self, response):
        self.response = response
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response


def answer(scenario_id, language="ru", *, additional=(), alternatives=(), slots=()):
    return {
        "language": language,
        "scenarios": [
            {"scenario_id": item, "reason": "Supported by the customer's words", "confidence_estimate": 0.8}
            for item in (scenario_id, *additional)
        ],
        "alternatives": list(alternatives),
        "slots": [{"name": name, "value": value} for name, value in slots],
        "is_continuation": False,
        "needs_clarification": False,
    }


def compact_answer(scenario_id, *, additional=(), slots=(), alternatives=()):
    return {
        "l": "ru",
        "s": [{"i": item, "r": "Client asks for the claim status"} for item in (scenario_id, *additional)],
        "a": list(alternatives),
        "v": [{"n": name, "v": value} for name, value in slots],
        "c": False,
        "q": False,
    }


@pytest.mark.asyncio
async def test_compact_response_restores_public_decision_and_omits_confidence(catalog):
    response = compact_answer("SC33", additional=("SC19",), slots=(("city", "Almaty"),))
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(response)).route(
        "Алматыда менің өтінішім қандай күйде?", RouterContext.empty()
    )

    assert [item.scenario_id for item in decision.scenarios] == ["SC33", "SC19"]
    assert decision.scenarios[0].reason == "Client asks for the claim status"
    assert decision.scenarios[0].confidence_estimate is None
    assert decision.slots == {"city": "Almaty"}
    assert decision.routing_error is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        compact_answer("SC99"),
        compact_answer("SC33", slots=(("city", "Almaty"), ("city", "Astana"))),
        compact_answer("SC33", alternatives=("SC19", "SC20", "SC21")),
    ],
)
async def test_compact_response_rejects_invalid_ids_slots_and_excess_alternatives(catalog, response):
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(response)).route(
        "Что с моим заявлением?", RouterContext.empty()
    )
    assert decision.routing_error is not None
    assert decision.scenarios[0].scenario_id == "SYS_UNCLEAR"


@pytest.fixture
def catalog():
    return Catalog.load(DATA_DIR)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("utterance", "expected_id"),
    [
        ("Я прямо сейчас на месте аварии, что делать?", "SC11"),
        ("Вчера меня ударили, виновник застрахован у вас, хочу выплату", "SC12"),
        ("Мою машину поцарапали вчера, у меня КАСКО, хочу заявить ущерб", "SC13"),
    ],
)
async def test_router_distinguishes_car_claims(catalog, utterance, expected_id):
    """A claim boundary disappears if the catalog exclusions are omitted."""
    fake = FakeStructuredModel(answer(expected_id))
    decision = await LLMRouter(catalog, structured_model=fake).route(utterance, RouterContext.empty())

    assert decision.scenarios[0].scenario_id == expected_id
    prompt = "\n".join(message.content for message in fake.messages)
    assert "SC11" in prompt and "SC12" in prompt and "SC13" in prompt
    assert "Accident is happening right now" in prompt
    assert "Client was at fault or claims under own CASCO" in prompt


@pytest.mark.asyncio
async def test_router_mixed_language_and_multiple_intents(catalog):
    fake = FakeStructuredModel(answer("SC02", "kk", additional=("SC04",)))
    text = "Сәлеметсіз бе, ОГПО оформить етіп, ағамды водитель ретінде қосыңыз"
    decision = await LLMRouter(catalog, structured_model=fake).route(text, RouterContext.empty())

    assert decision.language == "kk"
    assert [item.scenario_id for item in decision.scenarios] == ["SC02", "SC04"]
    assert text in fake.messages[-1].content


@pytest.mark.asyncio
async def test_prompt_includes_all_scenarios_and_bounded_context(catalog):
    fake = FakeStructuredModel(answer("SC19"))
    context = RouterContext(active_scenario="SC19", recent_turns=tuple(f"turn {n}" for n in range(10)))
    await LLMRouter(catalog, structured_model=fake).route("Выплату одобрили, но сумма слишком мала", context)

    prompt = "\n".join(message.content for message in fake.messages)
    for scenario_id in catalog.scenarios:
        assert scenario_id in prompt
    assert "turn 9" in prompt
    assert "turn 0" not in prompt
    assert "too small" in prompt.lower() or "payout" in prompt.lower()


@pytest.mark.asyncio
async def test_system_intent_is_valid(catalog):
    fake = FakeStructuredModel(answer("SYS_GOODBYE"))
    decision = await LLMRouter(catalog, structured_model=fake).route(
        "До свидания", RouterContext.empty()
    )
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_GOODBYE"]
    prompt = fake.messages[0].content
    assert "ends the conversation" in prompt
    assert "not about Saqta insurance" in prompt
    assert "life insurance which is not offered" in prompt


@pytest.mark.asyncio
async def test_unclear_intent_always_requires_clarification(catalog):
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(answer("SYS_UNCLEAR"))).route(
        "Не знаю, что делать со страховкой", RouterContext.empty()
    )
    assert decision.needs_clarification
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_UNCLEAR"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [answer("SC99"), answer("SC19", alternatives=("SC99",)), None, {}, answer("SC19", slots=(("made_up", "x"),))],
)
async def test_invalid_model_result_requires_clarification(catalog, response):
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(response)).route(
        "Что с выплатой?", RouterContext.empty()
    )
    assert decision.needs_clarification
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_UNCLEAR"]
    assert decision.alternatives == []


@pytest.mark.asyncio
async def test_timeout_requires_clarification(catalog):
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(asyncio.TimeoutError())).route(
        "Что с выплатой?", RouterContext.empty()
    )
    assert decision.needs_clarification
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_UNCLEAR"]
    assert decision.routing_error == "TimeoutError"


@pytest.mark.asyncio
async def test_legitimate_unclear_intent_has_no_routing_error(catalog):
    response = answer("SYS_UNCLEAR")
    response["needs_clarification"] = True
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(response)).route(
        "Нужна помощь", RouterContext.empty()
    )
    assert decision.needs_clarification
    assert decision.routing_error is None


@pytest.mark.asyncio
async def test_empty_model_selection_marks_routing_error(catalog):
    response = answer("SC19")
    response["scenarios"] = []
    response["needs_clarification"] = True
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(response)).route(
        "Нужна помощь", RouterContext.empty()
    )
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_UNCLEAR"]
    assert decision.needs_clarification
    assert decision.routing_error == "ValueError"


@pytest.mark.asyncio
async def test_timeout_preserves_known_kazakh_language(catalog):
    decision = await LLMRouter(catalog, structured_model=FakeStructuredModel(asyncio.TimeoutError())).route(
        "Төлем туралы сұрағым бар", RouterContext(language="kk")
    )
    assert decision.language == "kk"
    assert decision.needs_clarification


@pytest.mark.asyncio
async def test_router_constructs_without_api_key_and_falls_back_on_route(catalog, monkeypatch):
    """Server startup must not require credentials before a live route is attempted."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_ADMIN_KEY", raising=False)

    router = LLMRouter(catalog)
    decision = await router.route("Что с моим полисом?", RouterContext.empty())

    assert decision.needs_clarification
    assert [item.scenario_id for item in decision.scenarios] == ["SYS_UNCLEAR"]


def test_evaluation_requires_explicit_api_key():
    """A missing key must stop evaluation before any model is constructed."""
    script = Path(__file__).parents[1] / "scripts" / "evaluate_router.py"
    environment = os.environ.copy()
    environment.pop("OPENAI_API_KEY", None)
    completed = subprocess.run(
        [sys.executable, str(script), "--model", "gpt-6-sol"],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 2
    assert "OPENAI_API_KEY" in completed.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "error_name"),
    [
        (RuntimeError("service unavailable"), "RuntimeError"),
        (answer("SC19") | {"scenarios": [], "needs_clarification": True}, "ValueError"),
    ],
    ids=("api_error", "empty_selection"),
)
async def test_evaluation_aborts_when_router_reports_model_error(catalog, response, error_name):
    router = LLMRouter(catalog, structured_model=FakeStructuredModel(response))
    with pytest.raises(RuntimeError, match=rf"U001.*{error_name}"):
        await evaluate("gpt-6-sol", router=router)
