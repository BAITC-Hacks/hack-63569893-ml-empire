"""Checkpointed dialogue policy; irreversible actions execute only after an interrupt."""

from copy import deepcopy
from dataclasses import asdict
import re
from time import perf_counter

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from app.actions import ActionEngine
from app.catalog import Catalog
from app.domain import CallState, TurnResult
from app.reply import (confirmation_text, handoff_summary, knowledge_reply, normalize_no, normalize_slot,
                       normalize_yes, render_text)
from app.router import LLMRouter, RouterContext


def _route(state, source, scenario_id=None):
    return {"language": state.get("language", "ru"), "scenarios": [{
        "scenario_id": scenario_id or state.get("active_scenario") or "SYS_UNCLEAR",
        "reason": "Ответ в текущем диалоге", "confidence_estimate": None}],
        "alternatives": [], "slots": {}, "is_continuation": source == "continuation",
        "needs_clarification": False, "source": source}


def _values(state):
    return {name: entry["value"] for name, entry in state.get("slots", {}).items()}


def _record(state, node, **details):
    state["trace"] = [*state.get("trace", []), {"node": node, **details}]
    return state


def _looks_like_switch(text):
    # Only detect interruption cues, never choose a business scenario here.
    return bool(re.search(r"(?:\w.*\?|\b(?:лучше|вместо|сначала|другой|теперь|кстати|где|хочу|покажите|скажите|бірақ|басқа)\b)", text, re.I))


def build_graph(catalog: Catalog, router: LLMRouter, action_engine: ActionEngine,
                checkpointer: InMemorySaver):
    sessions = {}
    as_of = catalog.mock_backend["meta"]["as_of_date"]

    def session(state):
        sid = state["session_id"]
        if sid not in sessions:
            sessions[sid] = action_engine.new_session(sid)
        return sessions[sid]

    def store_slot(state, name, raw, source):
        value = normalize_slot(name, raw, catalog, as_of)
        if value is not None:
            state.setdefault("slots", {})[name] = {"value": value, "source": source,
                                                    "scenario_id": state.get("active_scenario")}
        return value

    def ask(state, name):
        state.update(expected_slot=name, text=catalog.slots[name]["prompt"][state["language"]],
                     status="collecting_slots", next_node="respond")
        return state

    def invoke_action(state, name, inputs, **kwargs):
        result = session(state).call(name, inputs, **kwargs)
        state["actions"].append({"name": name, "inputs": deepcopy(inputs), "result": result,
                                 "status": "error" if "error" in result else "completed"})
        if "error" not in result:
            state.setdefault("facts", {}).update(result)
        return result

    def transfer(state, queue="operator_general"):
        invoke_action(state, "transfer_to_operator", {"queue": queue, "summary": handoff_summary(state)})
        state.update(status="handoff", text="Соединяю с оператором и передаю суть вопроса." if state["language"] == "ru"
                     else "Операторға қосып, сұрағыңыздың мәнін жеткіземін.", next_node="respond", expected_slot=None)
        return state

    def ingest(raw):
        state = deepcopy(raw)
        for name, default in {"language": "ru", "client_id": None, "active_scenario": None,
                              "pending_scenarios": [], "pending_scenario_slots": {}, "suspended_scenarios": [], "slots": {},
                              "pending_confirmation": None, "clarification_count": 0,
                              "recent_turns": [], "offer_resume": False}.items():
            state.setdefault(name, default)
        session(state)
        state.update(actions=[], trace=[], timings={}, text="", status="completed", next_node="route")
        text = state["transcript"].strip()
        state["recent_turns"] = [*state["recent_turns"][-3:], text]
        if re.search(r"(?:вы|ты|сіз|сен).*(?:робот|бот|адам|жасанды)|(?:роботсыз|ботсыз)", text, re.I):
            language = "kk" if re.search(r"сіз|сен|сыз|жасанды", text, re.I) else state["language"]
            state.update(language=language, text="Да, я виртуальный помощник Saqta на основе искусственного интеллекта."
                         if language == "ru" else "Иә, мен жасанды интеллектке негізделген Saqta виртуалды көмекшісімін.", next_node="respond")
            state["route"] = _route(state, "continuation")
            return _record(state, "ingest", identity_disclosed=True)
        wants_resume = normalize_yes(text) or bool(re.fullmatch(r"(?:да[, ]+)?верн[её]мся|жалғастырайық", text, re.I))
        if state["offer_resume"] and wants_resume:
            if state["suspended_scenarios"]:
                saved = state["suspended_scenarios"].pop()
                state.update(saved)
            elif state["pending_scenarios"]:
                sid = state["pending_scenarios"].pop(0)
                state.update(active_scenario=sid, slots=state["pending_scenario_slots"].pop(sid, {}), facts={}, action_index=0)
            state.update(offer_resume=False, next_node="identify")
            state["route"] = _route(state, "continuation")
            return _record(state, "ingest", resumed=True)
        expected = state.get("expected_slot")
        if expected in catalog.slots and state.get("active_scenario") in catalog.scenarios and not _looks_like_switch(text) and catalog.slots[expected]["type"] != "text":
            phone_answer = None
            if expected == "policy_number" and re.match(r"^телефон\s*:", text, re.I):
                phone_answer = normalize_slot("phone", re.sub(r"^телефон\s*:\s*", "", text, flags=re.I), catalog, as_of)
            value = store_slot(state, "phone", phone_answer, "user") if phone_answer else store_slot(state, expected, text, "user")
            if value is not None:
                state.update(expected_slot=None, next_node="identify", clarification_count=0)
            else:
                ask(state, expected)
                state["clarification_count"] += 1
                if state["clarification_count"] >= 2:
                    transfer(state)
            state["route"] = _route(state, "continuation")
        return _record(state, "ingest")

    async def route(raw):
        state = deepcopy(raw)
        started = perf_counter()
        decision = await router.route(state["transcript"], RouterContext(
            active_scenario=state.get("active_scenario"), recent_turns=tuple(state.get("recent_turns", [])[:-1]),
            pending_question=catalog.slots[state["expected_slot"]]["prompt"][state["language"]] if state.get("expected_slot") in catalog.slots else None,
            language=state["language"]))
        state["route"] = {**decision.model_dump(), "source": "llm"}
        state["language"] = decision.language
        state["timings"]["route_ms"] = (perf_counter() - started) * 1000
        return _record(state, "route", source="llm", routing_error=getattr(decision, "routing_error", None))

    def policy(raw):
        state = deepcopy(raw)
        route = state["route"]
        valid = catalog.scenarios.keys() | catalog.system_intents
        if not route["scenarios"] or any(item["scenario_id"] not in valid for item in route["scenarios"]):
            route = _route(state, "llm", "SYS_UNCLEAR")
            route["needs_clarification"] = True
            state["route"] = route
        if route["needs_clarification"]:
            route["scenarios"] = [{"scenario_id": "SYS_UNCLEAR", "reason": "Нужно уточнение", "confidence_estimate": None}]
        route["scenarios"].sort(key=lambda item: 0 if item["scenario_id"] in catalog.scenarios and catalog.scenarios[item["scenario_id"]].priority == "urgent" else 1)
        chosen = route["scenarios"][0]["scenario_id"]
        if chosen == "SYS_UNCLEAR":
            # First uncertain utterance asks; two unsuccessful answers trigger handoff.
            state["clarification_count"] += 1
            if state["clarification_count"] >= 3:
                transfer(state)
            else:
                alternatives = [catalog.scenarios[i].name for i in route["alternatives"][:2] if i in catalog.scenarios]
                question = " или ".join(alternatives) if state["language"] == "ru" else " әлде ".join(alternatives)
                state.update(status="clarifying", next_node="respond", text=(f"Уточните, пожалуйста: {question}?" if question else "Уточните, пожалуйста, с каким вопросом по страховке помочь?") if state["language"] == "ru" else (f"Нақтылаңыз: {question}?" if question else "Сақтандыру бойынша қандай көмек керек?"))
            return _record(state, "policy", clarification_count=state["clarification_count"])
        if chosen.startswith("SYS_"):
            state.update(text=("Спасибо за обращение! Хорошего дня." if chosen == "SYS_GOODBYE" else "Помогаю с автострахованием, здоровьем, жильём и поездками. Какой вопрос вас интересует?") if state["language"] == "ru" else ("Хабарласқаныңызға рақмет! Күніңіз сәтті өтсін." if chosen == "SYS_GOODBYE" else "Көлік, денсаулық, тұрғын үй және сапар сақтандыруы бойынша көмектесемін."), next_node="respond")
            return _record(state, "policy")
        old = state.get("active_scenario")
        if old and old != chosen and state.get("expected_slot"):
            state["suspended_scenarios"].append({key: deepcopy(state.get(key)) for key in
                ("active_scenario", "slots", "expected_slot", "facts", "action_index")})
            if state["expected_slot"] == "__confirmation__":
                state["suspended_scenarios"][-1]["expected_slot"] = None
        if old != chosen or not state.get("expected_slot"):
            state.update(slots={}, facts={}, action_index=0)
        state.update(active_scenario=chosen, expected_slot=None, clarification_count=0, offer_resume=False, next_node="identify")
        queue = state["pending_scenarios"]
        for item in route["scenarios"][1:]:
            sid = item["scenario_id"]
            if sid in catalog.scenarios and sid != chosen and sid not in queue:
                queue.append(sid)
            if sid in catalog.scenarios and sid != chosen:
                allowed_queued = set(catalog.scenarios[sid].slots.required + catalog.scenarios[sid].slots.optional)
                snapshot = state["pending_scenario_slots"].setdefault(sid, {})
                for name, raw_value in route["slots"].items():
                    if name in allowed_queued:
                        value = normalize_slot(name, raw_value, catalog, as_of)
                        if value is not None:
                            snapshot[name] = {"value": value, "source": "llm", "scenario_id": sid}
        allowed = set(catalog.scenarios[chosen].slots.required + catalog.scenarios[chosen].slots.optional) | {"iin", "phone"}
        for name, value in route["slots"].items():
            if name in allowed:
                store_slot(state, name, value, "llm")
        return _record(state, "policy", active_scenario=chosen, pending_scenarios=queue[:])

    def identify(raw):
        state = deepcopy(raw)
        spec = catalog.scenarios[state["active_scenario"]]
        values = _values(state)
        if spec.requires_identification and not state.get("client_id"):
            if values.get("phone") or values.get("iin"):
                result = invoke_action(state, "find_client", {k: v for k, v in values.items() if k in {"phone", "iin"}})
                if "error" in result:
                    return _record(transfer(state), "identify", failed=True)
                state["client_id"] = result["client_id"]
            elif values.get("policy_number"):
                result = invoke_action(state, "get_policy", {"policy_number": values["policy_number"]})
                if "error" in result:
                    return _record(transfer(state), "identify", failed=True)
                state["client_id"] = result.get("client_id")
            elif values.get("claim_number"):
                # Claim lookup is a supported identifier for claim scenarios.
                result = invoke_action(state, "get_claim", {"claim_number": values["claim_number"]})
                if "error" in result:
                    return _record(transfer(state), "identify", failed=True)
            elif "policy_number" not in spec.slots.required and "claim_number" not in spec.slots.required:
                return _record(ask(state, "phone"), "identify")
        if spec.requires_identification and state.get("client_id") and "policy_number" in spec.slots.required and not values.get("policy_number"):
            result = invoke_action(state, "get_policies", {"client_id": state["client_id"]})
            if "error" not in result:
                active = [policy for policy in result["policies"] if policy["status"] == "active"]
                if len(active) == 1:
                    store_slot(state, "policy_number", active[0]["policy_number"], "identified_client")
        state["next_node"] = "collect_slots"
        return _record(state, "identify")

    def collect_slots(raw):
        state = deepcopy(raw)
        spec = catalog.scenarios[state["active_scenario"]]
        missing = next((name for name in spec.slots.required if name not in state["slots"]), None)
        if missing:
            ask(state, missing)
        else:
            state.update(next_node="act", expected_slot=None)
        return _record(state, "collect_slots", expected_slot=state.get("expected_slot"))

    def action_inputs(state, name):
        values = _values(state)
        facts = state.get("facts", {})
        sid = state["active_scenario"]
        values["client_id"] = state.get("client_id")
        product = {"SC02": "ogpo", "SC06": "travel", "SC12": "ogpo", "SC13": "casco", "SC14": "property", "SC16": "accident"}.get(sid)
        if product:
            values.setdefault("product_type", product)
        if name == "get_bm_class" and values.get("drivers_iin"):
            values["iin"] = values["drivers_iin"][0]
        if name == "get_bm_class" and values.get("new_driver_iin"):
            values["iin"] = values["new_driver_iin"]
        if name == "update_policy":
            values["add_driver_iin"] = values.get("new_driver_iin")
        if name == "calc_casco_price":
            values.setdefault("franchise", 0)
        if name == "get_policy" and values.get("culprit_vehicle_plate"):
            values["vehicle_plate"] = values["culprit_vehicle_plate"]
        if name == "create_claim" and sid == "SC12" and facts.get("policy_number"):
            values["policy_number"] = facts["policy_number"]
        if name == "calc_ogpo_price" and sid == "SC02":
            # Region is derived from the published plate map; vehicle type must be supplied.
            pricing = catalog.knowledge_base["products"]["ogpo"]["pricing"]
            values.setdefault("region", pricing["region_by_plate_code"].get(values.get("vehicle_plate", "")[-2:], pricing["region_by_plate_code"]["default"]))
        if name == "create_policy" and facts.get("price") is not None:
            values["price"] = facts["price"]
        if name == "kb_lookup":
            topics = {"SC03": "products.casco", "SC07": "products.property", "SC08": "products.accident",
                      "SC09": "products.dms", "SC11": "claims", "SC18": "claims", "SC24": "products.dms.e_card",
                      "SC31": "payments", "SC32": "bonus_malus", "SC34": "app_help", "SC38": "fraud_policy"}
            values["topic"] = values.get("topic") or topics.get(sid, "company")
        if name in {"send_sms", "create_policy"} and not values.get("phone") and state.get("client_id"):
            client = next((c for c in session(state).state["clients"] if c["client_id"] == state["client_id"]), {})
            values["phone"] = client.get("phone")
        if name == "resend_documents" and not values.get("policy_number"):
            policies = facts.get("policies", [])
            if len(policies) == 1:
                values["policy_number"] = policies[0]["policy_number"]
        if name == "send_sms":
            values["text"] = state.get("text") or str({k: v for k, v in facts.items() if k in {"payment_link", "claim_number", "address", "answer"}})
        fields = {part for field in catalog.actions[name].inputs for part in field.split("|")}
        extras = {"update_policy": {"add_driver_iin", "vehicle_plate"}, "create_policy": set(values) - {"client_id"},
                  "create_claim": {"policy_number"}, "send_sms": {"text"}}.get(name, set())
        return {key: value for key, value in values.items() if key in fields | extras and value is not None}

    def act(raw):
        state = deepcopy(raw)
        spec = catalog.scenarios[state["active_scenario"]]
        for index in range(state.get("action_index", 0), len(spec.actions)):
            name = spec.actions[index]
            state["action_index"] = index + 1
            if name == "find_client":
                continue  # Identification is performed in its own node.
            if name == "transfer_to_operator":
                handoff = spec.handoff or {}
                always = str(handoff.get("when", "")).startswith("always")
                urgent = spec.priority == "urgent"
                if always or urgent or state["active_scenario"] == "SC30" and state.get("facts", {}).get("payment_status") == "paid":
                    return _record(transfer(state, handoff.get("queue", "operator_general")), "act")
                continue
            inputs = action_inputs(state, name)
            missing = [field for field in catalog.actions[name].inputs if not any(part in inputs for part in field.split("|"))]
            if missing:
                if name == "send_sms":
                    continue  # An absent optional delivery address must not block an answer.
                askable = next((part for field in missing for part in field.split("|") if part in catalog.slots), None)
                if askable:
                    state["action_index"] = index
                    return _record(ask(state, askable), "act")
                return _record(transfer(state), "act", reason="missing_action_inputs")
            if catalog.actions[name].irreversible:
                pending = asdict(session(state).preview(name, inputs))
                # Save displayable state in this node BEFORE the next node interrupts.
                state.update(pending_confirmation=pending, text=confirmation_text(spec, pending, state["language"]),
                             status="awaiting_confirmation", next_node="confirm")
                state["actions"].append({"name": name, "inputs": inputs, "result": {}, "status": "preview"})
                return _record(state, "act", preview=name)
            result = invoke_action(state, name, inputs)
            if "error" in result or result.get("manual_quote_required"):
                return _record(transfer(state), "act", reason="action_requires_help")
            if state["active_scenario"] == "SC12" and name == "get_policy" and result.get("status") != "active":
                return _record(transfer(state), "act", reason="culprit_policy_inactive")
        state.update(status="completed", next_node="respond")
        return _record(state, "act")

    def confirm(state):
        answer = interrupt({"action_id": state["pending_confirmation"]["action_id"], "text": state["text"]})
        # Nothing with a side effect belongs in this replayed node.
        return {"confirmation_answer": answer}

    def execute_confirmed(raw):
        state = deepcopy(raw)
        answer = state["confirmation_answer"]
        state.update(transcript=answer, actions=[], trace=[], timings={}, text="")
        pending = state["pending_confirmation"]
        state["pending_confirmation"] = None
        state["route"] = _route(state, "confirmation")
        if normalize_yes(answer, state["language"]):
            result = invoke_action(state, pending["name"], pending["inputs"], action_id=pending["action_id"], confirmed=True)
            if "error" in result:
                transfer(state)
            else:
                state.update(next_node="act", status="completed")
        else:
            session(state).pending.pop(pending["action_id"], None)
            if normalize_no(answer, state["language"]):
                state.update(next_node="respond", status="completed", text="Действие отменено." if state["language"] == "ru" else "Әрекет тоқтатылды.", active_scenario=None)
            else:
                state.update(next_node="route", status="completed")
                state["action_index"] -= 1
                state["expected_slot"] = "__confirmation__"
        return _record(state, "execute_confirmed", confirmed=normalize_yes(answer))

    def respond(raw):
        state = deepcopy(raw)
        language = state["language"]
        if not state.get("text"):
            spec = catalog.scenarios.get(state.get("active_scenario"))
            if spec:
                fields = {**_values(state), **state.get("facts", {})}
                localized_knowledge = knowledge_reply(state["active_scenario"], catalog.knowledge_base, language)
                if localized_knowledge:
                    fields["answer"] = localized_knowledge
                template = spec.responses[language]["closing"]
                # Only claim SMS delivery when the action actually succeeded in this workflow.
                sent = any(a["name"] == "send_sms" and a["status"] == "completed" for a in state["actions"])
                if not sent:
                    had_answer = "{answer}" in template
                    template = re.sub(r"[^.!?]*(?:SMS|SMS-пен)[^.!?]*[.!?]?", "", template).strip()
                    if had_answer and "{answer}" not in template:
                        template = "{answer}"
                required = re.findall(r"\{(\w+)\}", template)
                if all(fields.get(key) is not None for key in required) and template:
                    state["text"] = template.format_map(fields)
                else:
                    state["text"] = "Запрос выполнен." if language == "ru" else "Сұраныс орындалды."
            else:
                state["text"] = "Чем ещё помочь?" if language == "ru" else "Тағы қалай көмектесейін?"
        if state["status"] == "completed" and (state["suspended_scenarios"] or state["pending_scenarios"]):
            state["offer_resume"] = True
            state["text"] += " Вернёмся к предыдущему вопросу?" if language == "ru" else "Алдыңғы сұраққа оралайық па?"
        state["text"] = render_text(state["text"], language)
        return _record(state, "respond", status=state["status"])

    builder = StateGraph(CallState)
    for name, node in {"ingest": ingest, "route": route, "policy": policy, "identify": identify,
                       "collect_slots": collect_slots, "act": act, "confirm": confirm,
                       "execute_confirmed": execute_confirmed, "respond": respond}.items():
        builder.add_node(name, node)
    builder.add_edge(START, "ingest")
    for name in ("ingest", "policy", "identify", "collect_slots", "act", "execute_confirmed"):
        builder.add_conditional_edges(name, lambda state: state["next_node"])
    builder.add_edge("route", "policy")
    builder.add_edge("confirm", "execute_confirmed")
    builder.add_edge("respond", END)
    return builder.compile(checkpointer=checkpointer)


async def run_turn(graph, session_id: str, turn_id: str, text: str) -> TurnResult:
    """One call maps to one checkpoint thread; paused confirmations resume explicitly."""
    config = {"configurable": {"thread_id": session_id}}
    started = perf_counter()
    snapshot = await graph.aget_state(config)
    if snapshot.next and any(task.interrupts for task in snapshot.tasks):
        # Updating metadata is separate from resuming; confirm still receives a plain string.
        await graph.aupdate_state(config, {"turn_id": turn_id})
        output = await graph.ainvoke(Command(resume=text), config)
    else:
        output = await graph.ainvoke({"session_id": session_id, "turn_id": turn_id, "transcript": text}, config)
    timings = {**output.get("timings", {}), "total_ms": (perf_counter() - started) * 1000}
    return TurnResult(session_id=session_id, turn_id=turn_id, text=output["text"], language=output["language"],
        route=output["route"], actions=output.get("actions", []), trace=output.get("trace", []),
        pending_scenarios=output.get("pending_scenarios", []), pending_confirmation=output.get("pending_confirmation"),
        status=output["status"], timings=timings)
