import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.actions import ActionEngine


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def catalog():
    actions = json.loads((ROOT / "datas/actions.json").read_text())
    return SimpleNamespace(
        actions={item["name"]: SimpleNamespace(**item) for item in actions["actions"]},
        mock_backend=json.loads((ROOT / "datas/mock_backend.json").read_text()),
        knowledge_base=json.loads((ROOT / "datas/knowledge_base.json").read_text()),
        error_codes=actions["error_codes"],
    )


CASES = [
    ("create_policy", {"product_type": "ogpo", "phone": "+77010000001"}, "policies", "policy_number"),
    ("renew_policy", {"policy_number": "SQ-OGPO-102850"}, "policies", "policy_number"),
    ("update_policy", {"policy_number": "SQ-OGPO-104501", "add_driver_iin": "920607400233"}, "policies", "extra_premium"),
    ("cancel_policy", {"policy_number": "SQ-OGPO-104501", "cancel_reason": "Sold vehicle"}, "policies", "refund_amount"),
    ("create_claim", {"product_type": "casco", "policy_number": "SQ-CASCO-204118", "incident_date": "2026-09-20", "incident_description": "Parking damage"}, "claims", "claim_number"),
    ("create_dispute", {"claim_number": "CL-500287", "complaint_text": "Assessment is too low"}, "disputes", "ticket_id"),
    ("book_inspection", {"claim_number": "CL-500330", "city": "Almaty", "preferred_date": "2026-10-05"}, "inspections", "slot_datetime"),
    ("book_appointment", {"policy_number": "SQ-DMS-604220", "doctor_specialty": "therapist", "city": "Astana", "preferred_date": "2026-10-05"}, "appointments", "clinic_name"),
    ("update_contact", {"client_id": "C001", "contact_field": "email", "new_value": "new@example.com"}, "clients", "status"),
]


def test_confirmation_is_required_and_idempotent(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    inputs = {"product_type": "ogpo", "phone": "+77010000001"}
    original_count = actions.count("policies")
    pending = actions.preview("create_policy", inputs)
    assert pending.name == "create_policy"
    assert pending.inputs == inputs
    assert pending.summary
    assert actions.count("policies") == original_count
    assert actions.call("create_policy", inputs)["error"]["code"] == "invalid_input"
    first = actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=True)
    second = actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=True)
    assert first == second
    assert first["policy_number"]
    assert actions.count("policies") == original_count + 1


@pytest.mark.parametrize("name,inputs,collection,field", CASES)
def test_all_irreversible_actions_preview_execute_once(catalog, name, inputs, collection, field):
    actions = ActionEngine(catalog).new_session("call-1")
    before = json.dumps(actions.state, sort_keys=True)
    pending = actions.preview(name, inputs)
    assert json.dumps(actions.state, sort_keys=True) == before
    assert actions.call(name, inputs, action_id=pending.action_id, confirmed=False)["error"]["code"] == "invalid_input"
    assert json.dumps(actions.state, sort_keys=True) == before
    pending = actions.preview(name, inputs)
    first = actions.call(name, inputs, action_id=pending.action_id, confirmed=True)
    after_first = json.dumps(actions.state, sort_keys=True)
    assert field in first, (name, first)
    assert actions.call(name, inputs, action_id=pending.action_id, confirmed=True) == first
    assert json.dumps(actions.state, sort_keys=True) == after_first


def test_rejected_confirmation_invalidates_preview(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    inputs = {"product_type": "ogpo", "phone": "+77010000001"}
    pending = actions.preview("create_policy", inputs)
    assert actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=False)["error"]["code"] == "invalid_input"
    assert actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.count("policies") == 11


def test_changed_arguments_and_name_cannot_reuse_preview(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    inputs = {"product_type": "ogpo", "phone": "+77010000001"}
    pending = actions.preview("create_policy", inputs)
    assert actions.call("create_policy", {**inputs, "phone": "+77010000002"}, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.call("renew_policy", {"policy_number": "SQ-OGPO-102850"}, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.count("policies") == 11


def test_duplicate_id_cannot_be_replayed_with_changed_arguments(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    inputs = {"product_type": "ogpo", "phone": "+77010000001"}
    pending = actions.preview("create_policy", inputs)
    assert "policy_number" in actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=True)
    assert actions.call("create_policy", {**inputs, "phone": "+77010000002"}, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.count("policies") == 12


def test_mutating_returned_preview_cannot_authorize_changed_arguments(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    original = {"product_type": "ogpo", "phone": "+77010000001"}
    pending = actions.preview("create_policy", original)
    pending.inputs["phone"] = "+77010000002"
    assert actions.call("create_policy", pending.inputs, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.count("policies") == 11


def test_confirmed_create_policy_rejects_malformed_phone_without_mutating(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    inputs = {"product_type": "ogpo", "phone": "+7"}
    pending = actions.preview("create_policy", inputs)
    assert actions.call("create_policy", inputs, action_id=pending.action_id, confirmed=True)["error"]["code"] == "invalid_input"
    assert actions.count("policies") == 11
