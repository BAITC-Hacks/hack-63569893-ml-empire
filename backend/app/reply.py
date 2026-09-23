"""Deterministic slot normalization and privacy-safe bilingual speech text."""

from datetime import date, timedelta
import re


def _words(text):
    return " ".join(re.findall(r"[\w]+", str(text).lower().replace("ё", "е")))


def normalize_yes(text, language=None):
    # A closed vocabulary deliberately rejects qualified or contradictory consent.
    return _words(text) in {"да", "да подтверждаю", "подтверждаю", "да согласен", "да согласна",
                            "иә", "иә растаймын", "растаймын", "иә келісемін", "келісемін"}


def normalize_no(text, language=None):
    return _words(text) in {"нет", "нет отмена", "нет не надо", "не надо", "отмена", "не подтверждаю",
                            "жоқ", "жоқ керек емес", "керек емес", "растамаймын"}


_DIGITS = dict(zip("ноль нуль один одна два две три четыре пять шесть семь восемь девять нөл бір екі үш төрт бес алты жеті сегіз тоғыз".split(),
                  "0 0 1 1 2 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9".split()))
_ALIASES = {"алматы": "Almaty", "алмата": "Almaty", "астана": "Astana", "шымкент": "Shymkent",
            "караганда": "Karaganda", "қарағанды": "Karaganda", "актобе": "Aktobe", "ақтөбе": "Aktobe",
            "атырау": "Atyrau", "павлодар": "Pavlodar", "өскемен": "Oskemen", "усть-каменогорск": "Oskemen",
            "телефон": "phone", "почта": "email", "пошта": "email", "адрес": "address", "мекенжай": "address",
            "легковая": "car", "легковой": "car", "жеңіл": "car", "квартира": "apartment", "дом": "house",
            "огпо": "ogpo", "каско": "casco", "дмс": "dms", "путешествие": "travel", "жилье": "property"}


def normalize_slot(name, raw, catalog, as_of_date):
    """Return a catalog-validated native value, or None for an invalid answer."""
    if raw is None or name not in catalog.slots:
        return None
    spec = catalog.slots[name]
    value = str(raw).strip()
    if not value:
        return None
    if name == "phone":
        tokens = re.findall(r"\w+", value.lower())
        if any(token in _DIGITS for token in tokens):
            if any(token not in _DIGITS and token not in {"плюс", "plus"} and not token.isdigit() for token in tokens):
                return None
            value = "+" + "".join(_DIGITS.get(token, token if token.isdigit() else "") for token in tokens)
        else:
            value = re.sub(r"[\s()\-]", "", value)
        if len(value) == 11 and value.startswith("8"):
            value = "+7" + value[1:]
        elif len(value) == 11 and value.startswith("7"):
            value = "+" + value
    if spec["type"] == "date":
        offsets = {"сегодня": 0, "бүгін": 0, "завтра": 1, "ертең": 1, "послезавтра": 2, "бүрсігүні": 2,
                   "вчера": -1, "кеше": -1, "позавчера": -2}
        if value.lower() in offsets:
            return (date.fromisoformat(as_of_date) + timedelta(days=offsets[value.lower()])).isoformat()
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            return None
    if spec["type"] == "boolean":
        if isinstance(raw, bool):
            return raw
        return True if normalize_yes(value) or value.lower() == "true" else False if normalize_no(value) or value.lower() == "false" else None
    if spec["type"] == "integer":
        try:
            integer = int(value.replace(" ", ""))
            return integer if integer >= 0 else None
        except ValueError:
            return None
    if spec["type"] == "enum":
        if name == "vehicle_type" and normalize_yes(value):
            return "car"
        value = _ALIASES.get(value.lower(), value)
        return next((candidate for candidate in spec["values"] if str(candidate).lower() == value.lower()), None)
    if spec["type"] == "list":
        values = raw if isinstance(raw, list) else re.findall(r"\d+", value)
        return values if values and all(re.fullmatch(spec["pattern"], str(item)) for item in values) else None
    if name in {"policy_number", "claim_number", "vehicle_plate", "culprit_vehicle_plate"}:
        value = value.upper().replace(" ", "")
    if spec.get("pattern") and not re.fullmatch(spec["pattern"], value):
        return None
    return value


def mask_personal(text):
    text = str(text)
    text = re.sub(r"\+?[78][\d ()-]{9,}\d", "[телефон скрыт]", text)
    text = re.sub(r"\b\d{12}\b", "[ИИН скрыт]", text)
    text = re.sub(r"\b(?:SQ-(?:OGPO|CASCO|TRVL|PROP|NS|DMS)|CL)-\d+\b", "[номер скрыт]", text)
    text = re.sub(r"\b\d{3}[A-Z]{2,3}\d{2}\b", "[номер скрыт]", text)
    return re.sub(r"[^\s@,]+@[^\s@,]+", "[почта скрыта]", text)


def number_words(number, language):
    if number < 0:
        return ("минус " if language == "ru" else "минус ") + number_words(-number, language)
    if language == "kk":
        ones = "нөл бір екі үш төрт бес алты жеті сегіз тоғыз".split()
        tens = ["", "он", "жиырма", "отыз", "қырық", "елу", "алпыс", "жетпіс", "сексен", "тоқсан"]
        if number < 10:
            return ones[number]
        if number < 100:
            return tens[number // 10] + (" " + ones[number % 10] if number % 10 else "")
        for divisor, label in ((10**9, "миллиард"), (10**6, "миллион"), (1000, "мың"), (100, "жүз")):
            if number >= divisor:
                return number_words(number // divisor, language) + " " + label + (" " + number_words(number % divisor, language) if number % divisor else "")
    ones = "ноль один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать".split()
    if number < 20:
        return ones[number]
    if number < 100:
        tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"]
        return tens[number // 10] + (" " + ones[number % 10] if number % 10 else "")
    if number < 1000:
        hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"]
        return hundreds[number // 100] + (" " + number_words(number % 100, language) if number % 100 else "")
    for divisor, forms in ((10**9, ("миллиард", "миллиарда", "миллиардов")), (10**6, ("миллион", "миллиона", "миллионов")), (1000, ("тысяча", "тысячи", "тысяч"))):
        if number >= divisor:
            count = number // divisor
            prefix = number_words(count, language)
            if divisor == 1000:
                prefix = re.sub(r"\bодин$", "одна", prefix)
                prefix = re.sub(r"\bдва$", "две", prefix)
            form = forms[2] if 11 <= count % 100 <= 14 else forms[0] if count % 10 == 1 else forms[1] if 2 <= count % 10 <= 4 else forms[2]
            return prefix + " " + form + (" " + number_words(number % divisor, language) if number % divisor else "")


def render_text(text, language):
    masked = mask_personal(text)
    if language == "kk":
        for source, replacement in {"телефон скрыт": "телефон жасырылған", "ИИН скрыт": "ЖСН жасырылған", "номер скрыт": "нөмір жасырылған", "почта скрыта": "пошта жасырылған"}.items():
            masked = masked.replace(source, replacement)
    return re.sub(r"\b\d+\b", lambda match: number_words(int(match[0]), language), masked)


def handoff_summary(state):
    return mask_personal(f"Сценарий: {state.get('active_scenario') or 'не определён'}. "
                         f"Запрос: {state.get('transcript', '')[:300]}. "
                         f"Собраны поля: {', '.join(state.get('slots', {}))}.")


def knowledge_reply(scenario_id, knowledge, language):
    """Short localized summaries of the bundled facts used by information routes."""
    if scenario_id == "SC09":
        prices = knowledge["products"]["dms"]["individual_price_per_year_kzt"]
        return (f"ДМС на год: Базовая программа — {prices['Basic']} тенге, Комфорт — {prices['Comfort']} тенге."
                if language == "ru" else f"Бір жылдық ДМС: Базалық бағдарлама — {prices['Basic']} теңге, Комфорт — {prices['Comfort']} теңге.")
    if scenario_id == "SC31":
        return ("Оплатить можно картой в приложении, на сайте или в офисе, а также по ссылке из SMS; для компаний доступен банковский перевод."
                if language == "ru" else "Қосымшада, сайтта, кеңседе картамен немесе SMS сілтемесі арқылы төлеуге болады; компанияларға банктік аударым қолжетімді.")
    if scenario_id == "SC34":
        return ("Проверьте номер телефона; если код не пришёл, подождите минуту и запросите новый. Доступно до пяти кодов в час."
                if language == "ru" else "Телефон нөмірін тексеріңіз; код келмесе, бір минут күтіп, жаңасын сұратыңыз. Сағатына бес кодқа дейін алуға болады.")
    return None


def confirmation_text(scenario, pending, language):
    action_labels = {
        "create_policy": ("оформление полиса", "полисті рәсімдеу"),
        "renew_policy": ("продление полиса", "полисті ұзарту"),
        "update_policy": ("изменение полиса", "полисті өзгерту"),
        "cancel_policy": ("расторжение договора", "шартты бұзу"),
        "create_claim": ("регистрация страхового заявления", "сақтандыру өтінішін тіркеу"),
        "create_dispute": ("регистрация возражения", "қарсылықты тіркеу"),
        "book_inspection": ("запись на осмотр", "қарауға жазылу"),
        "book_appointment": ("запись к врачу", "дәрігерге жазылу"),
        "update_contact": ("изменение контактных данных", "байланыс деректерін өзгерту"),
    }
    title = action_labels.get(pending.get("name"), (scenario.name, scenario.name))[language == "kk"]
    labels = {"policy_number": "полис", "cancel_reason": "причина", "phone": "телефон",
              "preferred_date": "дата", "new_value": "новые данные", "contact_field": "поле",
              "city": "город", "doctor_specialty": "врач", "claim_number": "заявление", "price": "цена",
              "product_type": "продукт", "incident_date": "дата события", "incident_description": "описание",
              "trip_country": "страна", "trip_start": "начало поездки", "trip_end": "конец поездки",
              "travelers_count": "число туристов", "traveler_max_age": "возраст", "vehicle_type": "тип автомобиля",
              "vehicle_plate": "госномер", "drivers_iin": "ИИН водителей", "add_driver_iin": "ИИН водителя"}
    if language == "kk":
        labels.update(policy_number="полис", cancel_reason="себеп", preferred_date="күн", new_value="жаңа деректер",
                      contact_field="дерек", city="қала", doctor_specialty="дәрігер", claim_number="өтініш", price="баға",
                      product_type="өнім", incident_date="оқиға күні", incident_description="сипаттама",
                      trip_country="ел", trip_start="сапар басы", trip_end="сапар соңы", travelers_count="жолаушылар саны",
                      traveler_max_age="жас", vehicle_type="көлік түрі", vehicle_plate="көлік нөмірі", drivers_iin="ЖСН", add_driver_iin="ЖСН")
    private = {"new_value", "property_address", "address", "full_name"}
    hidden = "[жасырылған]" if language == "kk" else "[скрыто]"
    details = "; ".join(f"{labels.get(key, key)}: {hidden if key in private else value}" for key, value in pending["inputs"].items() if key != "client_id")
    text = f"Подтвердите: {title}. {details}. Выполнить?" if language == "ru" else f"Растаңыз: {title}. {details}. Орындаймыз ба?"
    return render_text(text, language)
