import json
from pathlib import Path

import pytest

from app.catalog import Catalog
from app.config import Settings


DATA_DIR = Path(__file__).parents[2] / "datas"


def test_catalog_loads_valid_dataset_and_resolves_references():
    catalog = Catalog.load(DATA_DIR)

    assert len(catalog.scenarios) == 40
    assert len(catalog.system_intents) == 3
    assert len(catalog.actions) == 31
    assert all(action in catalog.actions for scenario in catalog.scenarios.values() for action in scenario.actions)
    assert all(slot in catalog.slots for scenario in catalog.scenarios.values() for slot in scenario.slots.required)


def test_catalog_preserves_system_intent_boundaries():
    catalog = Catalog.load(DATA_DIR)
    assert catalog.system_intent_descriptions["SYS_OUT_OF_SCOPE"] == (
        "Request is not about Saqta insurance services (loans, weather, jobs, life insurance which is not offered)."
    )


def test_duplicate_scenario_id_is_rejected(tmp_path):
    _copy_dataset(tmp_path)
    path = tmp_path / "scenarios.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["scenarios"].append(document["scenarios"][0])
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValueError, match="Duplicate scenario_id"):
        Catalog.load(tmp_path)


@pytest.mark.parametrize(
    ("filename", "collection", "field"),
    [
        ("actions.json", "actions", "name"),
        ("slots.json", "slots", "name"),
        ("scenarios.json", "system_intents", "id"),
    ],
)
def test_duplicate_catalog_ids_are_rejected(tmp_path, filename, collection, field):
    _copy_dataset(tmp_path)
    path = tmp_path / filename
    document = json.loads(path.read_text(encoding="utf-8"))
    document[collection].append(document[collection][0])
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValueError, match=f"Duplicate {field} in {filename}"):
        Catalog.load(tmp_path)


@pytest.mark.parametrize(
    ("filename", "collection", "field", "invalid"),
    [
        ("slots.json", "slots", "name", None),
        ("slots.json", "slots", "name", 123),
        ("scenarios.json", "system_intents", "id", None),
        ("scenarios.json", "system_intents", "id", 123),
    ],
)
def test_catalog_ids_require_nonempty_strings(tmp_path, filename, collection, field, invalid):
    _copy_dataset(tmp_path)
    path = tmp_path / filename
    document = json.loads(path.read_text(encoding="utf-8"))
    if invalid is None:
        del document[collection][0][field]
    else:
        document[collection][0][field] = invalid
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        Catalog.load(tmp_path)
    assert filename in str(exc_info.value)
    assert f"0.{field}" in str(exc_info.value)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("actions", "missing_action", "unknown actions"),
        ("slots", "missing_slot", "unknown required slots"),
    ],
)
def test_unknown_scenario_references_are_rejected(tmp_path, field, value, message):
    _copy_dataset(tmp_path)
    path = tmp_path / "scenarios.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    if field == "slots":
        document["scenarios"][0]["slots"]["required"].append(value)
    else:
        document["scenarios"][0][field].append(value)
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        Catalog.load(tmp_path)


def test_missing_dataset_file_names_file(tmp_path):
    with pytest.raises(FileNotFoundError, match="scenarios.json"):
        Catalog.load(tmp_path)


def test_settings_validate_data_dir_at_creation(tmp_path):
    with pytest.raises(ValueError, match="data_dir"):
        Settings(data_dir=tmp_path)

    assert Settings().data_dir == DATA_DIR


def _copy_dataset(destination):
    for filename in (
        "scenarios.json",
        "actions.json",
        "slots.json",
        "knowledge_base.json",
        "mock_backend.json",
    ):
        (destination / filename).write_bytes((DATA_DIR / filename).read_bytes())
