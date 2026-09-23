"""LLM scenario selection with catalog validation and safe clarification fallback."""

import asyncio
import logging
from dataclasses import dataclass
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, ConfigDict

from app.catalog import Catalog
from app.config import Settings


_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class RouterContext:
    """Only routing-relevant, recent state from the current call."""

    active_scenario: str | None = None
    recent_turns: tuple[str, ...] = ()
    pending_question: str | None = None
    language: Literal["ru", "kk"] | None = None

    @classmethod
    def empty(cls) -> "RouterContext":
        return cls()


class SelectedScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    reason: str
    confidence_estimate: float | None


class RouterDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: Literal["ru", "kk"]
    scenarios: list[SelectedScenario]
    alternatives: list[str]
    slots: dict[str, str | None]
    is_continuation: bool
    needs_clarification: bool
    routing_error: str | None = None


class _ModelSlot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    value: str | None


class _ModelDecision(BaseModel):
    """Wire schema avoids arbitrary-key objects, which Structured Outputs disallows."""

    model_config = ConfigDict(extra="forbid")

    language: Literal["ru", "kk"]
    scenarios: list[SelectedScenario]
    alternatives: list[str]
    slots: list[_ModelSlot]
    is_continuation: bool
    needs_clarification: bool


def build_router_messages(text: str, context: RouterContext, catalog: Catalog):
    """Present all catalog choices and boundaries with bounded call history."""

    lines = [
        "Choose the client's Saqta Insurance intent from the catalog below. Return JSON matching the schema.",
        "Use only listed IDs. Include all distinct intents in order of mention; put an urgent intent first.",
        "Use not_this_if boundaries to distinguish close scenarios. Never invent a business route.",
        "For unclear intent choose SYS_UNCLEAR and set needs_clarification=true.",
        "Choose response language ru or kk from the client's dominant language; mixed Kazakh/Russian may be kk.",
        "Each reason must briefly cite the client's words and the relevant boundary, without hidden reasoning.",
        "confidence_estimate is an uncalibrated model estimate, not a probability of correctness.",
        "Slots must use catalog slot names. Return a list of name/value pairs; use null if the value is missing.",
        "Catalog:",
    ]
    for scenario in catalog.scenarios.values():
        boundary = "; ".join(
            f"{rule['condition']} -> {rule['use_instead']}" for rule in scenario.not_this_if
        )
        examples = "; ".join(
            f"{language}: {scenario.examples[language][0]}"
            for language in ("ru", "kk")
            if scenario.examples.get(language)
        )
        lines.append(
            f"{scenario.scenario_id} [{scenario.priority}] {scenario.description} "
            f"not_this_if: {boundary or 'none'}; examples: {examples}"
        )
    for intent_id in sorted(catalog.system_intents):
        lines.append(f"{intent_id}: {catalog.system_intent_descriptions[intent_id]}")
    lines.append("Valid slots: " + ", ".join(sorted(catalog.slots)))

    recent = "\n".join(turn[:500] for turn in context.recent_turns[-4:])
    state = (
        f"Active scenario: {context.active_scenario or 'none'}\n"
        f"Previous response language: {context.language or 'unknown'}\n"
        f"Pending question: {(context.pending_question or 'none')[:500]}\n"
        f"Recent turns:\n{recent or 'none'}\n"
        f"Current utterance:\n{text}"
    )
    return [SystemMessage(content="\n".join(lines)), HumanMessage(content=state)]


class LLMRouter:
    def __init__(
        self,
        catalog: Catalog,
        settings: Settings | None = None,
        *,
        structured_model=None,
    ):
        self.catalog = catalog
        self.settings = settings or Settings()
        self.structured_model = structured_model

    async def route(self, text: str, context: RouterContext) -> RouterDecision:
        if not text.strip():
            return _clarify(context.language or "ru")
        try:
            if self.structured_model is None:
                self.structured_model = ChatOpenAI(
                    model=self.settings.router_model,
                    use_responses_api=True,
                    reasoning_effort="low",
                ).with_structured_output(_ModelDecision, method="json_schema")
            response = await asyncio.wait_for(
                self.structured_model.ainvoke(build_router_messages(text, context, self.catalog)),
                timeout=self.settings.router_timeout_seconds,
            )
            result = _ModelDecision.model_validate(response)
            self._validate_ids(result)
            slots = {slot.name: slot.value for slot in result.slots}
            if len(slots) != len(result.slots) or set(slots) - self.catalog.slots.keys():
                raise ValueError("Invalid or duplicate slot names")
            if not result.scenarios:
                raise ValueError("No scenario selected")
            return RouterDecision(
                language=result.language,
                scenarios=result.scenarios,
                alternatives=result.alternatives,
                slots=slots,
                is_continuation=result.is_continuation,
                needs_clarification=result.needs_clarification,
            )
        except Exception as exc:
            _LOGGER.warning("Router failed safely: %s", type(exc).__name__)
            return _clarify(context.language or "ru", routing_error=type(exc).__name__)

    def _validate_ids(self, result: _ModelDecision) -> None:
        valid = self.catalog.scenarios.keys() | self.catalog.system_intents
        selected_ids = [item.scenario_id for item in result.scenarios]
        if any(item not in valid for item in (*selected_ids, *result.alternatives)):
            raise ValueError("Unknown scenario ID")
        if len(selected_ids) != len(set(selected_ids)):
            raise ValueError("Duplicate scenario ID")
        if "SYS_UNCLEAR" in selected_ids and (
            not result.needs_clarification or selected_ids != ["SYS_UNCLEAR"]
        ):
            raise ValueError("SYS_UNCLEAR must be the sole scenario and require clarification")


def _clarify(
    language: Literal["ru", "kk"] = "ru", *, routing_error: str | None = None
) -> RouterDecision:
    return RouterDecision(
        language=language,
        scenarios=[
            SelectedScenario(
                scenario_id="SYS_UNCLEAR",
                reason="Маршрут не удалось определить; требуется уточнение.",
                confidence_estimate=None,
            )
        ],
        alternatives=[],
        slots={},
        is_continuation=False,
        needs_clarification=True,
        routing_error=routing_error,
    )
