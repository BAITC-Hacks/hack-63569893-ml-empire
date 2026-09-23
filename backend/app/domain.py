"""Typed records from the startup catalog."""

from pydantic import BaseModel, ConfigDict, Field
from typing import Any, Literal, TypedDict


class ScenarioSlots(BaseModel):
    model_config = ConfigDict(extra="forbid")

    required: list[str]
    optional: list[str]


class ScenarioSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    slug: str
    name: str
    domain: str
    category: str
    description: str
    not_this_if: list[dict]
    priority: str
    fast_path_eligible: bool
    requires_identification: bool
    slots: ScenarioSlots
    actions: list[str]
    requires_confirmation: bool
    handoff: dict | None
    examples: dict[str, list[str]]
    responses: dict[str, dict[str, str]]


class ActionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    inputs: list[str]
    outputs: list[str]
    errors: list[str]
    irreversible: bool


class SlotSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, strict=True)
    type: str
    description: str
    prompt: dict[str, str]
    pattern: str | None = None
    values: list[str | int | float] | None = None


class SystemIntentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, strict=True)
    description: str
    behavior: str
    response: dict[str, str]


class RouteScenario(BaseModel):
    scenario_id: str
    reason: str
    confidence_estimate: float | None = None


class TurnRoute(BaseModel):
    language: Literal["ru", "kk"]
    scenarios: list[RouteScenario]
    alternatives: list[str] = Field(default_factory=list)
    slots: dict[str, str | None] = Field(default_factory=dict)
    is_continuation: bool = False
    needs_clarification: bool = False
    source: Literal["llm", "continuation", "confirmation"]
    routing_error: str | None = None


class TurnResult(BaseModel):
    session_id: str
    turn_id: str
    text: str
    language: Literal["ru", "kk"]
    route: TurnRoute
    actions: list[dict] = Field(default_factory=list)
    trace: list[dict] = Field(default_factory=list)
    pending_scenarios: list[str] = Field(default_factory=list)
    pending_confirmation: dict | None = None
    status: Literal["completed", "collecting_slots", "awaiting_confirmation", "clarifying", "handoff"]
    timings: dict[str, float] = Field(default_factory=dict)


class CallState(TypedDict, total=False):
    session_id: str
    turn_id: str
    transcript: str
    language: str
    client_id: str | None
    active_scenario: str | None
    pending_scenarios: list[str]
    pending_scenario_slots: dict[str, dict[str, dict[str, Any]]]
    suspended_scenarios: list[dict]
    slots: dict[str, dict[str, Any]]
    pending_confirmation: dict | None
    clarification_count: int
    trace: list[dict]
    timings: dict[str, float]
    route: dict
    actions: list[dict]
    text: str
    status: str
    next_node: str
    expected_slot: str | None
    confirmation_answer: str
    action_index: int
    facts: dict
    recent_turns: list[str]
    offer_resume: bool
