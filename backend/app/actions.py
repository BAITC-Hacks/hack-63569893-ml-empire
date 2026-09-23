"""Per-call mock actions with explicit confirmation for irreversible operations."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, timedelta
import json
import re
from uuid import uuid4


@dataclass(frozen=True)
class PendingAction:
    action_id: str
    name: str
    inputs: dict
    summary: str


def _field(value, key):
    return value[key] if isinstance(value, dict) else getattr(value, key)


def _valid_phone(value):
    return isinstance(value, str) and re.fullmatch(r"\+7\d{10}", value) is not None


class ActionEngine:
    def __init__(self, catalog):
        self.catalog = catalog

    def new_session(self, session_id: str) -> SessionActions:
        return SessionActions(self.catalog, session_id)


class SessionActions:
    def __init__(self, catalog, session_id: str):
        self.catalog = catalog
        self.session_id = session_id
        self.state = deepcopy(catalog.mock_backend)
        self.pending: dict[str, PendingAction] = {}
        self.completed: dict[str, tuple[str, str, dict]] = {}
        self.handlers = {
            name: getattr(self, f"_do_{name}") for name in catalog.actions
        }

    def count(self, collection: str) -> int:
        return len(self.state.get(collection, []))

    def preview(self, name: str, inputs: dict) -> PendingAction:
        if name not in self.handlers or not _field(self.catalog.actions[name], "irreversible"):
            raise ValueError(f"Action cannot be previewed: {name}")
        if not isinstance(inputs, dict):
            raise ValueError("Action inputs must be a dictionary")
        captured = deepcopy(inputs)
        summary = f"Confirm {name.replace('_', ' ')}: " + ", ".join(
            f"{key}={value}" for key, value in sorted(captured.items())
        )
        pending = PendingAction(str(uuid4()), name, captured, summary)
        self.pending[pending.action_id] = pending
        return deepcopy(pending)

    def call(self, name: str, inputs: dict, *, action_id: str | None = None,
             confirmed: bool = False) -> dict:
        if name not in self.handlers:
            return self._error("invalid_input", "Unknown action")
        if not isinstance(inputs, dict):
            return self._error("invalid_input", "Action inputs must be an object")
        spec = self.catalog.actions[name]
        if _field(spec, "irreversible"):
            fingerprint = self._fingerprint(inputs)
            if action_id in self.completed:
                saved_name, saved_fingerprint, result = self.completed[action_id]
                if confirmed and saved_name == name and saved_fingerprint == fingerprint:
                    return deepcopy(result)
                return self._error("invalid_input", "Action confirmation does not match")
            pending = self.pending.get(action_id)
            if not confirmed:
                if pending and pending.name == name:
                    self.pending.pop(action_id)
                return self._error("invalid_input", "Explicit confirmation required")
            if pending is None or pending.name != name or self._fingerprint(pending.inputs) != fingerprint:
                return self._error("invalid_input", "Action confirmation does not match")
            result = self.handlers[name](inputs)
            self._check_error(name, result)
            self.pending.pop(action_id)
            if "error" not in result:
                self.completed[action_id] = (name, fingerprint, deepcopy(result))
            return deepcopy(result)
        result = self.handlers[name](inputs)
        self._check_error(name, result)
        return deepcopy(result)

    @staticmethod
    def _fingerprint(inputs):
        return json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    @staticmethod
    def _error(code, message):
        return {"error": {"code": code, "message": message}}

    def _check_error(self, name, result):
        if "error" in result:
            code = result["error"]["code"]
            if code not in self.catalog.error_codes:
                raise ValueError(f"Undeclared action error: {name}: {code}")

    def _find(self, collection, **match):
        return next((item for item in self.state[collection]
                     if all(item.get(key) == value for key, value in match.items())), None)

    def _policy(self, inputs):
        return self._find("policies", policy_number=inputs.get("policy_number"))

    def _status(self, policy):
        if policy.get("status") == "cancelled":
            return "cancelled"
        today = date.fromisoformat(self.catalog.mock_backend["meta"]["as_of_date"])
        if date.fromisoformat(policy["start_date"]) > today:
            return "pending"
        return "active" if date.fromisoformat(policy["end_date"]) >= today else "expired"

    def _active_policy(self, inputs):
        policy = self._policy(inputs)
        if policy is None:
            return None, self._error("not_found", "Policy not found")
        if self._status(policy) != "active":
            return None, self._error("policy_inactive", "Policy is not active")
        return policy, None

    def _new_id(self, prefix, collection):
        return f"{prefix}-{self.count(collection) + 1:06d}"

    def _client_for_policy(self, policy):
        return self._find("clients", client_id=policy["client_id"])

    def _do_find_client(self, inputs):
        key = "phone" if inputs.get("phone") else "iin" if inputs.get("iin") else None
        if key is None:
            return self._error("invalid_input", "Phone or IIN is required")
        if key == "phone" and not _valid_phone(inputs["phone"]):
            return self._error("invalid_input", "Phone must be in +7XXXXXXXXXX format")
        client = self._find("clients", **{key: inputs[key]})
        if client is None:
            return self._error("not_found", "Client not found")
        return {"client_id": client["client_id"], "full_name": client["full_name"]}

    def _do_get_policies(self, inputs):
        if self._find("clients", client_id=inputs.get("client_id")) is None:
            return self._error("not_found", "Client not found")
        return {"policies": [dict(p, status=self._status(p)) for p in self.state["policies"]
                             if p["client_id"] == inputs["client_id"]]}

    def _do_get_policy(self, inputs):
        if inputs.get("policy_number"):
            policy = self._policy(inputs)
        elif inputs.get("vehicle_plate"):
            policy = next((p for p in self.state["policies"] if
                           p.get("details", {}).get("vehicle_plate") == inputs["vehicle_plate"]), None)
        else:
            return self._error("invalid_input", "Policy number or vehicle plate is required")
        if policy is None:
            return self._error("not_found", "Policy not found")
        return dict(policy, status=self._status(policy))

    def _do_get_bm_class(self, inputs):
        iin = inputs.get("iin")
        if not isinstance(iin, str) or len(iin) != 12 or not iin.isdigit():
            return self._error("invalid_input", "IIN must contain 12 digits")
        client = self._find("clients", iin=iin)
        return {"bm_class": client["bm_class"] if client else self.state["defaults"]["unknown_iin_bm_class"]}

    def _do_calc_ogpo_price(self, inputs):
        pricing = self.catalog.knowledge_base["products"]["ogpo"]["pricing"]
        region = str(inputs.get("region", "")).lower()
        if region not in pricing["base_by_region_kzt"]:
            region = "other" if region else ""
        vehicle = inputs.get("vehicle_type")
        drivers = inputs.get("drivers_iin")
        term = str(inputs.get("term_months", 12))
        if (not region or vehicle not in pricing["vehicle_type_coef"] or
                not isinstance(drivers, list) or not drivers or term not in pricing["term_coef"]):
            return self._error("invalid_input", "Invalid OGPO pricing inputs")
        classes = [self._do_get_bm_class({"iin": iin}) for iin in drivers]
        if any("error" in value for value in classes):
            return self._error("invalid_input", "Invalid driver IIN")
        worst_coef = max(pricing["bm_coef"][value["bm_class"]] for value in classes)
        price = pricing["base_by_region_kzt"][region] * pricing["vehicle_type_coef"][vehicle] * worst_coef * pricing["term_coef"][term]
        return {"price": round(price)}

    def _do_calc_casco_price(self, inputs):
        pricing = self.catalog.knowledge_base["products"]["casco"]["pricing"]
        try:
            value, year = int(inputs["car_value"]), int(inputs["car_year"])
            franchise = str(int(inputs["franchise"]))
        except (KeyError, TypeError, ValueError):
            return self._error("invalid_input", "Invalid CASCO pricing inputs")
        package = inputs.get("package", "Standard")
        age = date.fromisoformat(self.state["meta"]["as_of_date"]).year - year
        if value <= 0 or age < 0 or franchise not in pricing["franchise_coef"] or package not in pricing["package_coef"]:
            return self._error("invalid_input", "Invalid CASCO pricing inputs")
        if age > pricing["max_car_age"][package]:
            return self._error("not_eligible", "Car exceeds maximum age")
        rate = pricing["rate_by_car_age"]["0-3" if age <= 3 else "4-7" if age <= 7 else "8-10"] if age <= 10 else pricing["rate_by_car_age"]["8-10"]
        return {"price": round(value * rate * pricing["franchise_coef"][franchise] * pricing["package_coef"][package])}

    def _do_calc_travel_price(self, inputs):
        kb = self.catalog.knowledge_base["products"]["travel"]
        try:
            start = date.fromisoformat(inputs["trip_start"])
            end = date.fromisoformat(inputs["trip_end"])
            travelers = int(inputs["travelers_count"])
            age = int(inputs["traveler_max_age"])
            country = inputs["trip_country"].strip().lower()
        except (KeyError, TypeError, ValueError, AttributeError):
            return self._error("invalid_input", "Invalid travel pricing inputs")
        if end < start or travelers < 1 or age < 0 or not country:
            return self._error("invalid_input", "Invalid travel pricing inputs")
        if age > 75:
            return self._error("not_eligible", "Travelers over 75 require an operator")
        if country in {"russia", "belarus", "kyrgyzstan", "uzbekistan", "tajikistan", "armenia", "azerbaijan", "georgia", "moldova"}:
            zone = "A"
        elif country in {"germany", "france", "italy", "spain", "uk", "united kingdom", "netherlands", "switzerland", "poland", "czech republic", "austria"}:
            zone = "B"
        elif country in {"usa", "united states", "canada"}:
            zone = "D"
        else:
            zone = "C"
        details = kb["zones"][zone]
        return {"price": round(details["rate_per_day_kzt"] * ((end - start).days + 1) * travelers * (2 if age >= 65 else 1)), "zone": zone, "coverage": details["coverage"]}

    def _do_calc_property_price(self, inputs):
        product = self.catalog.knowledge_base["products"]["property"]
        property_type = inputs.get("property_type")
        amount = str(inputs.get("sum_insured"))
        if property_type not in {"apartment", "house"} or amount not in product["price_per_year_kzt"]:
            return self._error("invalid_input", "Invalid property pricing inputs")
        return {"price": round(product["price_per_year_kzt"][amount] * (product["house_coef"] if property_type == "house" else 1))}

    def _do_calc_accident_price(self, inputs):
        prices = self.catalog.knowledge_base["products"]["accident"]["price_per_year_kzt"]
        amount = str(inputs.get("sum_insured"))
        if amount not in prices:
            return self._error("invalid_input", "Invalid insured amount")
        return {"price": prices[amount]}

    def _do_create_policy(self, inputs):
        product, phone = inputs.get("product_type"), inputs.get("phone")
        if product not in self.catalog.knowledge_base["products"] or not _valid_phone(phone):
            return self._error("invalid_input", "Product and valid phone are required")
        client = self._find("clients", phone=phone)
        number = self._new_id(f"SQ-{product.upper()}", "policies")
        today = date.fromisoformat(self.state["meta"]["as_of_date"])
        self.state["policies"].append({"policy_number": number, "client_id": client["client_id"] if client else None,
            "product": product, "start_date": today.isoformat(), "end_date": (today + timedelta(days=364)).isoformat(),
            "premium": inputs.get("price"), "details": {}, "status": "pending_payment"})
        self.state.setdefault("sms", []).append({"phone": phone, "kind": "payment_link", "policy_number": number})
        return {"policy_number": number}

    def _do_renew_policy(self, inputs):
        policy = self._policy(inputs)
        if policy is None:
            return self._error("not_found", "Policy not found")
        if self._status(policy) == "cancelled":
            return self._error("not_eligible", "Cancelled policy cannot be renewed")
        today = date.fromisoformat(self.state["meta"]["as_of_date"])
        old_end = date.fromisoformat(policy["end_date"])
        if old_end > today + timedelta(days=60):
            return self._error("not_eligible", "Policy is not near renewal")
        number = self._new_id(f"SQ-{policy['product'].upper()}", "policies")
        premium = policy.get("premium") or 0
        self.state["policies"].append(dict(deepcopy(policy), policy_number=number,
            start_date=(max(today, old_end + timedelta(days=1))).isoformat(),
            end_date=(max(today, old_end + timedelta(days=1)) + timedelta(days=364)).isoformat()))
        return {"policy_number": number, "price": premium}

    def _do_update_policy(self, inputs):
        policy, error = self._active_policy(inputs)
        if error:
            return error
        changes = {key: inputs[key] for key in ("add_driver_iin", "vehicle_plate", "vehicle") if inputs.get(key)}
        if not changes:
            return self._error("invalid_input", "A policy change is required")
        if "add_driver_iin" in changes:
            drivers = policy["details"].setdefault("drivers_iin", [])
            if changes["add_driver_iin"] not in drivers:
                drivers.append(changes["add_driver_iin"])
        for key in ("vehicle_plate", "vehicle"):
            if key in changes:
                policy["details"][key] = changes[key]
        extra = round((policy.get("premium") or 0) * 0.1)
        policy["premium"] = (policy.get("premium") or 0) + extra
        return {"extra_premium": extra}

    def _do_cancel_policy(self, inputs):
        policy = self._policy(inputs)
        if policy is None:
            return self._error("not_found", "Policy not found")
        if policy.get("status") == "cancelled":
            return self._error("already_done", "Policy already cancelled")
        if self._status(policy) != "active":
            return self._error("policy_inactive", "Policy is not active")
        if any(c["policy_number"] == policy["policy_number"] and c.get("status") == "paid" for c in self.state["claims"]):
            return self._error("not_eligible", "Paid claim prevents refund")
        today = date.fromisoformat(self.state["meta"]["as_of_date"])
        end = date.fromisoformat(policy["end_date"])
        unused_months = max(0, (end.year - today.year) * 12 + end.month - today.month - (end.day < today.day))
        refund = round((policy.get("premium") or 0) * unused_months / 12 * 0.9)
        policy["status"] = "cancelled"
        policy["cancel_reason"] = inputs.get("cancel_reason", "")
        return {"refund_amount": refund}

    def _do_create_claim(self, inputs):
        product = inputs.get("product_type")
        description = inputs.get("incident_description")
        try:
            incident = date.fromisoformat(inputs["incident_date"])
        except (KeyError, TypeError, ValueError):
            return self._error("invalid_input", "Valid incident date is required")
        if not product or not description or incident > date.fromisoformat(self.state["meta"]["as_of_date"]):
            return self._error("invalid_input", "Product and incident description are required")
        policy = self._policy(inputs) if inputs.get("policy_number") else next((p for p in self.state["policies"] if p["product"] == product and self._status(p) == "active"), None)
        if policy is None or policy["product"] != product:
            return self._error("not_found", "Matching policy not found")
        if self._status(policy) != "active":
            return self._error("policy_inactive", "Policy is not active")
        number = self._new_id("CL", "claims")
        self.state["claims"].append({"claim_number": number, "client_id": policy["client_id"],
            "policy_number": policy["policy_number"], "claim_type": product, "incident_date": incident.isoformat(),
            "description": description, "status": "registered", "next_step": "Submit supporting documents."})
        return {"claim_number": number}

    def _do_get_claim(self, inputs):
        claim = self._find("claims", claim_number=inputs["claim_number"]) if inputs.get("claim_number") else next((c for c in self.state["claims"] if c["client_id"] == inputs.get("client_id")), None)
        if claim is None:
            return self._error("not_found", "Claim not found")
        return {"claim_number": claim["claim_number"], "status": claim["status"], "next_step": claim["next_step"]}

    def _do_create_dispute(self, inputs):
        if self._find("claims", claim_number=inputs.get("claim_number")) is None:
            return self._error("not_found", "Claim not found")
        ticket = self._new_id("DSP", "disputes")
        self.state.setdefault("disputes", []).append({"ticket_id": ticket, **deepcopy(inputs)})
        return {"ticket_id": ticket}

    def _do_book_inspection(self, inputs):
        if self._find("claims", claim_number=inputs.get("claim_number")) is None:
            return self._error("not_found", "Claim not found")
        point = next((p for p in self.catalog.knowledge_base["inspection_points"] if p["city"].lower() == str(inputs.get("city", "")).lower()), None)
        if point is None:
            return self._error("no_availability", "No inspection point in requested city")
        try:
            booked = date.fromisoformat(inputs["preferred_date"])
        except (KeyError, TypeError, ValueError):
            return self._error("no_availability", "No slot for requested date")
        if booked < date.fromisoformat(self.state["meta"]["as_of_date"]):
            return self._error("no_availability", "Requested date has passed")
        slot = f"{booked.isoformat()}T10:00:00"
        self.state.setdefault("inspections", []).append({"claim_number": inputs["claim_number"], "slot_datetime": slot, "address": point["address"]})
        return {"slot_datetime": slot, "address": point["address"]}

    def _do_book_appointment(self, inputs):
        policy, error = self._active_policy(inputs)
        if error:
            return error
        if policy["product"] != "dms":
            return self._error("not_covered", "Policy does not cover medical appointments")
        coverage = self._do_check_coverage({"policy_number": policy["policy_number"], "service_name": inputs.get("doctor_specialty", "")})
        if not coverage.get("covered"):
            return self._error("not_covered", "Specialty is not covered")
        clinic = next((c for c in self.catalog.knowledge_base["clinics"] if c["city"].lower() == str(inputs.get("city", "")).lower() and any(s.lower() == str(inputs.get("doctor_specialty", "")).lower() for s in c["specialties"])), None)
        if clinic is None:
            return self._error("no_availability", "No clinic for requested specialty")
        try:
            booked = date.fromisoformat(inputs["preferred_date"])
        except (KeyError, TypeError, ValueError):
            return self._error("no_availability", "No slot for requested date")
        if booked < date.fromisoformat(self.state["meta"]["as_of_date"]):
            return self._error("no_availability", "Requested date has passed")
        slot = f"{booked.isoformat()}T10:00:00"
        self.state.setdefault("appointments", []).append({"policy_number": policy["policy_number"], "clinic_name": clinic["name"], "slot_datetime": slot})
        return {"clinic_name": clinic["name"], "slot_datetime": slot}

    def _do_check_coverage(self, inputs):
        policy, error = self._active_policy(inputs)
        if error:
            return error
        if policy["product"] != "dms":
            return {"covered": False, "note": "Not a DMS policy"}
        package = policy["details"]["package"]
        rule = self.catalog.knowledge_base["products"]["dms"]["packages"][package]
        service = str(inputs.get("service_name", "")).lower().strip()
        service = {"dentist": "dental treatment", "dentistry": "dental treatment"}.get(service, service)
        matching_coverage = next((item for item in rule["covered"] if service and service in item.lower()), None)
        matching_exclusion = next((item for item in rule["not_covered"] if service and service in item.lower()), None)
        covered = matching_coverage is not None and matching_exclusion is None
        return {"covered": covered, "note": matching_coverage if covered else matching_exclusion or "Not covered by DMS package"}

    def _do_list_clinics(self, inputs):
        clinics = [c for c in self.catalog.knowledge_base["clinics"] if c["city"].lower() == str(inputs.get("city", "")).lower()]
        return {"clinics": clinics} if clinics else self._error("not_found", "No clinics found")

    def _do_resend_documents(self, inputs):
        policy, error = self._active_policy(inputs)
        if error:
            return error
        client = self._client_for_policy(policy)
        destination = client.get("email") if client else None
        if not destination:
            return self._error("not_found", "Client email not found")
        self.state.setdefault("documents_sent", []).append({"policy_number": policy["policy_number"], "sent_to": destination})
        return {"sent_to": destination}

    def _do_check_payment(self, inputs):
        payment = next((p for p in self.state["payments"] if p["client_id"] == inputs.get("client_id") and p["date"] == inputs.get("payment_date")), None)
        if payment is None:
            return self._error("not_found", "Payment not found")
        return {"payment_status": payment["status"], "amount": payment["amount"]}

    def _do_update_contact(self, inputs):
        client = self._find("clients", client_id=inputs.get("client_id"))
        if client is None:
            return self._error("not_found", "Client not found")
        field, value = inputs.get("contact_field"), inputs.get("new_value")
        if field not in {"phone", "email", "address"} or not isinstance(value, str) or not value.strip():
            return self._error("invalid_input", "Invalid contact field or value")
        if field == "email" and "@" not in value or field == "phone" and not _valid_phone(value):
            return self._error("invalid_input", "Invalid contact value")
        client[field] = value
        return {"status": "updated"}

    def _do_request_document(self, inputs):
        policy = self._policy(inputs)
        if policy is None:
            return self._error("not_found", "Policy not found")
        if inputs.get("document_type") not in self.catalog.knowledge_base["documents_available"] or "@" not in str(inputs.get("email", "")):
            return self._error("invalid_input", "Invalid document type or email")
        self.state.setdefault("documents_sent", []).append(deepcopy(inputs))
        return {"sent_to": inputs["email"]}

    def _do_get_offices(self, inputs):
        office = next((o for o in self.catalog.knowledge_base["offices"] if o["city"].lower() == str(inputs.get("city", "")).lower()), None)
        return {"address": office["address"], "hours": office["hours"]} if office else self._error("not_found", "Office not found")

    def _do_kb_lookup(self, inputs):
        topic = inputs.get("topic", "")
        value = self.catalog.knowledge_base
        for part in str(topic).split("."):
            if not isinstance(value, dict) or part not in value:
                return self._error("not_found", "Knowledge topic not found")
            value = value[part]
        return {"answer": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}

    def _do_send_sms(self, inputs):
        phone = inputs.get("phone")
        if not _valid_phone(phone):
            return self._error("invalid_input", "Valid phone is required")
        self.state.setdefault("sms", []).append(deepcopy(inputs))
        return {"status": "sent"}

    def _do_create_callback(self, inputs):
        phone = inputs.get("phone")
        if not _valid_phone(phone) or not inputs.get("callback_time"):
            return self._error("invalid_input", "Phone and callback time are required")
        self.state.setdefault("callbacks", []).append(deepcopy(inputs))
        return {"status": "scheduled"}

    def _do_create_complaint(self, inputs):
        ticket = self._new_id("CMP", "complaints")
        self.state.setdefault("complaints", []).append({"ticket_id": ticket, **deepcopy(inputs)})
        return {"ticket_id": ticket}

    def _do_report_fraud(self, inputs):
        ticket = self._new_id("FRD", "fraud_reports")
        self.state.setdefault("fraud_reports", []).append({"ticket_id": ticket, **deepcopy(inputs)})
        return {"ticket_id": ticket}

    def _do_transfer_to_operator(self, inputs):
        queue = inputs.get("queue")
        self.state.setdefault("transfers", []).append(deepcopy(inputs))
        return {"status": "transferred", "queue": queue}
