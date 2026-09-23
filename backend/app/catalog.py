"""Load and validate the bundled Voice Router dataset."""

import json
from dataclasses import dataclass
from pathlib import Path

from pydantic import TypeAdapter

from app.config import REQUIRED_DATA_FILES
from app.domain import ActionSpec, ScenarioSpec


@dataclass(frozen=True)
class Catalog:
    scenarios: dict[str, ScenarioSpec]
    system_intents: set[str]
    actions: dict[str, ActionSpec]
    error_codes: dict[str, str]
    slots: dict[str, dict]
    knowledge_base: dict
    mock_backend: dict

    @classmethod
    def load(cls, data_dir: Path) -> "Catalog":
        data_dir = Path(data_dir)
        documents = {name: _read_json(data_dir / name) for name in REQUIRED_DATA_FILES}
        scenarios_json = documents["scenarios.json"]
        actions_json = documents["actions.json"]
        slots_json = documents["slots.json"]

        scenarios = TypeAdapter(list[ScenarioSpec]).validate_python(scenarios_json["scenarios"])
        actions = TypeAdapter(list[ActionSpec]).validate_python(actions_json["actions"])
        slot_rows = TypeAdapter(list[dict]).validate_python(slots_json["slots"])
        system_rows = TypeAdapter(list[dict]).validate_python(scenarios_json["system_intents"])
        error_codes = TypeAdapter(dict[str, str]).validate_python(actions_json["error_codes"])

        scenario_specs = _unique_by(scenarios, "scenario_id", "scenarios.json")
        action_specs = _unique_by(actions, "name", "actions.json")
        slot_specs = _unique_by(slot_rows, "name", "slots.json")
        system_intents = _unique_ids(system_rows, "id", "scenarios.json")

        for scenario in scenarios:
            unknown_actions = set(scenario.actions) - action_specs.keys()
            if unknown_actions:
                raise ValueError(f"{scenario.scenario_id}: unknown actions {sorted(unknown_actions)}")
            unknown_required = set(scenario.slots.required) - slot_specs.keys()
            if unknown_required:
                raise ValueError(f"{scenario.scenario_id}: unknown required slots {sorted(unknown_required)}")
            unknown_optional = set(scenario.slots.optional) - slot_specs.keys()
            if unknown_optional:
                raise ValueError(f"{scenario.scenario_id}: unknown optional slots {sorted(unknown_optional)}")

        for action in actions:
            unknown_errors = set(action.errors) - error_codes.keys()
            if unknown_errors:
                raise ValueError(f"{action.name}: unknown error codes {sorted(unknown_errors)}")

        return cls(
            scenarios=scenario_specs,
            system_intents=system_intents,
            actions=action_specs,
            error_codes=error_codes,
            slots=slot_specs,
            knowledge_base=TypeAdapter(dict).validate_python(documents["knowledge_base.json"]),
            mock_backend=TypeAdapter(dict).validate_python(documents["mock_backend.json"]),
        )


def _read_json(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as source:
            return json.load(source)
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Catalog file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in catalog file {path}: {exc}") from exc


def _unique_by(rows: list, field: str, filename: str) -> dict:
    values = [row[field] if isinstance(row, dict) else getattr(row, field) for row in rows]
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate {field} in {filename}")
    return dict(zip(values, rows, strict=True))


def _unique_ids(rows: list[dict], field: str, filename: str) -> set[str]:
    values = [row[field] for row in rows]
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate {field} in {filename}")
    return set(values)
