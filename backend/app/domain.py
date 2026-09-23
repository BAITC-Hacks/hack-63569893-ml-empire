"""Typed records from the startup catalog."""

from pydantic import BaseModel, ConfigDict


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
