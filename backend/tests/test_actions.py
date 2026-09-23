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


def test_all_declared_actions_are_registered(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert set(actions.handlers) == set(catalog.actions)
    assert len(actions.handlers) == 31


def test_find_client_and_not_found(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert actions.call("find_client", {"phone": "+77010000001"}) == {
        "client_id": "C001", "full_name": "Arman Tulegenov"
    }
    assert actions.call("find_client", {"phone": "+77010000099"}) == {
        "error": {"code": "not_found", "message": "Client not found"}
    }


@pytest.mark.parametrize("name,inputs,field,expected", [
    ("get_policies", {"client_id": "C001"}, "policies", list),
    ("get_policy", {"policy_number": "SQ-OGPO-104501"}, "status", str),
    ("get_bm_class", {"iin": "850314300121"}, "bm_class", str),
    ("calc_ogpo_price", {"region": "almaty", "vehicle_type": "car", "drivers_iin": ["850314300121"]}, "price", int),
    ("calc_casco_price", {"car_value": 12000000, "car_year": 2019, "franchise": 50000}, "price", int),
    ("calc_travel_price", {"trip_country": "Turkey", "trip_start": "2026-10-01", "trip_end": "2026-10-03", "travelers_count": 2, "traveler_max_age": 36}, "price", int),
    ("calc_property_price", {"property_type": "apartment", "sum_insured": 10000000}, "price", int),
    ("calc_accident_price", {"sum_insured": 3000000}, "price", int),
    ("get_claim", {"claim_number": "CL-500198"}, "status", str),
    ("check_coverage", {"policy_number": "SQ-DMS-604220", "service_name": "dentist"}, "covered", bool),
    ("list_clinics", {"city": "Almaty"}, "clinics", list),
    ("resend_documents", {"policy_number": "SQ-DMS-604220"}, "sent_to", str),
    ("check_payment", {"client_id": "C009", "payment_date": "2026-06-01"}, "payment_status", str),
    ("request_document", {"policy_number": "SQ-DMS-604220", "document_type": "policy_duplicate", "email": "a@example.com"}, "sent_to", str),
    ("get_offices", {"city": "Almaty"}, "address", str),
    ("kb_lookup", {"topic": "company.contact_center.phone"}, "answer", str),
    ("send_sms", {"phone": "+77010000001"}, "status", str),
    ("create_callback", {"phone": "+77010000001", "callback_time": "2026-10-02T10:00:00"}, "status", str),
    ("create_complaint", {"complaint_text": "Service was delayed"}, "ticket_id", str),
    ("report_fraud", {"fraud_details": "Suspected forged claim"}, "ticket_id", str),
    ("transfer_to_operator", {"queue": "claims_team"}, "status", str),
])
def test_reversible_actions_return_declared_shape(catalog, name, inputs, field, expected):
    result = ActionEngine(catalog).new_session("call-1").call(name, inputs)
    assert field in result, (name, result)
    assert isinstance(result[field], expected)


def test_formula_values_come_from_knowledge_base(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert actions.call("calc_ogpo_price", {"region": "almaty", "vehicle_type": "car", "drivers_iin": ["850314300121"]})["price"] == 30400
    assert actions.call("calc_casco_price", {"car_value": 12000000, "car_year": 2019, "franchise": 50000})["price"] == 540000
    assert actions.call("calc_travel_price", {"trip_country": "Turkey", "trip_start": "2026-10-01", "trip_end": "2026-10-03", "travelers_count": 2, "traveler_max_age": 36}) == {"price": 6600, "zone": "C", "coverage": "50 000 USD"}
    assert actions.call("calc_property_price", {"property_type": "house", "sum_insured": 10000000})["price"] == 37500
    assert actions.call("calc_accident_price", {"sum_insured": 3000000})["price"] == 15000


def test_sessions_are_isolated_and_catalog_data_is_unchanged(catalog):
    original = json.dumps(catalog.mock_backend, sort_keys=True)
    engine = ActionEngine(catalog)
    first = engine.new_session("call-1")
    second = engine.new_session("call-2")
    assert first.call("send_sms", {"phone": "+77010000001"})["status"] == "sent"
    assert len(first.state["sms"]) == 1
    assert second.state.get("sms", []) == []
    assert json.dumps(catalog.mock_backend, sort_keys=True) == original


def test_invalid_inputs_and_domain_errors(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert actions.call("find_client", {})["error"]["code"] == "invalid_input"
    assert actions.call("calc_casco_price", {"car_value": 1000000, "car_year": 2000, "franchise": 0})["error"]["code"] == "not_eligible"
    assert actions.call("calc_travel_price", {"trip_country": "Turkey", "trip_start": "2026-10-01", "trip_end": "2026-10-03", "travelers_count": 1, "traveler_max_age": 76})["error"]["code"] == "not_eligible"
    assert actions.call("get_policy", {"policy_number": "missing"})["error"]["code"] == "not_found"


def test_profile_lookups_return_matching_records(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    policies = actions.call("get_policies", {"client_id": "C001"})["policies"]
    assert {item["policy_number"] for item in policies} == {"SQ-OGPO-104501", "SQ-CASCO-204118"}
    assert actions.call("get_policy", {"vehicle_plate": "101AAA02"})["policy_number"] == "SQ-OGPO-103990"
    assert actions.call("get_bm_class", {"iin": "000000000000"}) == {"bm_class": "3"}
    assert actions.call("get_claim", {"claim_number": "CL-500311"}) == {
        "claim_number": "CL-500311", "status": "documents_requested",
        "next_step": "Upload the act from the building management company; review starts after that."
    }
    assert actions.call("check_payment", {"client_id": "C003", "payment_date": "2026-09-30"}) == {
        "payment_status": "charged_policy_not_issued", "amount": 31200
    }


def test_dms_coverage_uses_package_rules(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert actions.call("check_coverage", {"policy_number": "SQ-DMS-604220", "service_name": "lab tests"})["covered"] is True
    assert actions.call("check_coverage", {"policy_number": "SQ-DMS-604220", "service_name": "dental implants"})["covered"] is False
    assert actions.call("check_coverage", {"policy_number": "SQ-DMS-604220", "service_name": "dentist"})["covered"] is True


def test_malformed_phone_is_invalid_input(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    assert actions.call("find_client", {"phone": "+7"})["error"]["code"] == "invalid_input"
    assert actions.call("send_sms", {"phone": "+7"})["error"]["code"] == "invalid_input"
    assert actions.call("create_callback", {"phone": "+7", "callback_time": "2026-10-02T10:00:00"})["error"]["code"] == "invalid_input"


@pytest.mark.parametrize("country", [
    "Austria", "Belgium", "Bulgaria", "Croatia", "Czechia", "Denmark", "Estonia",
    "Finland", "France", "Germany", "Greece", "Hungary", "Iceland", "Italy",
    "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Netherlands",
    "Norway", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain",
    "Sweden", "Switzerland", "United Kingdom",
])
def test_schengen_country_uses_zone_b(catalog, country):
    actions = ActionEngine(catalog).new_session("call-1")
    result = actions.call("calc_travel_price", {
        "trip_country": country, "trip_start": "2026-10-01", "trip_end": "2026-10-03",
        "travelers_count": 1, "traveler_max_age": 30,
    })
    assert result == {"price": 2700, "zone": "B", "coverage": "30 000 EUR"}


def test_unrecognized_travel_country_is_invalid_input(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    result = actions.call("calc_travel_price", {
        "trip_country": "Finlnd", "trip_start": "2026-10-01", "trip_end": "2026-10-03",
        "travelers_count": 1, "traveler_max_age": 30,
    })
    assert result["error"]["code"] == "invalid_input"


def test_casco_lite_older_than_pricing_table_requires_operator(catalog):
    actions = ActionEngine(catalog).new_session("call-1")
    result = actions.call("calc_casco_price", {
        "car_value": 4000000, "car_year": 2013, "franchise": 50000, "package": "Lite",
    })
    assert result["error"]["code"] == "not_eligible"
    assert "operator" in result["error"]["message"].lower()


@pytest.mark.parametrize("name", ["create_policy", "renew_policy", "update_policy", "cancel_policy", "create_claim", "create_dispute", "book_inspection", "book_appointment", "update_contact"])
def test_irreversible_actions_reject_unconfirmed_calls(catalog, name):
    actions = ActionEngine(catalog).new_session("call-1")
    before = json.dumps(actions.state, sort_keys=True)
    assert actions.call(name, {})["error"]["code"] == "invalid_input"
    assert json.dumps(actions.state, sort_keys=True) == before
