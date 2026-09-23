import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, Plus, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
import sourceCatalog from '../../../datas/scenarios.json';
import sourceActions from '../../../datas/actions.json';
import sourceSlots from '../../../datas/slots.json';
import { CATALOG_STORAGE_KEY, CatalogValidationError, MAX_CATALOG_BYTES, createScenario, parseCatalog, removeScenario, replaceCatalogEntry, restoreCatalogDraft, serializeCatalog } from '../catalog-model';
import type { CatalogDocument, CatalogIssue, CatalogReferences } from '../catalog-model';
import '../catalog-editor.css';

const baseline = sourceCatalog as CatalogDocument;
const refs: CatalogReferences = { actions: sourceActions.actions, slots: sourceSlots.slots, queues: sourceActions.queues, requiredScenarioIds: baseline.scenarios.map(item => item.scenario_id), requiredSystemIds: baseline.system_intents.map(item => item.id) };
const copy = {
  ru: { title: 'Редактор сценариев', intro: 'Локальная рабочая версия каталога. Изменения не влияют на активный маршрутизатор: экспортируйте JSON и передайте его разработчику сервера.', note: 'Используйте только синтетические данные. 40 базовых сценариев и 3 системных намерения защищены от удаления.', search: 'Поиск по ID, названию или описанию', add: 'Новый сценарий', import: 'Импорт JSON', export: 'Экспорт JSON', reset: 'Исходный каталог', save: 'Сохранить в браузере', apply: 'Применить к черновику', discard: 'Отменить правки', delete: 'Удалить сценарий', json: 'Полный JSON сценария', jsonHelp: 'Здесь редактируются слоты, действия, исключения, RU/KK-примеры и ответы. ID сохраняется. Примените правки перед выбором другого сценария.', name: 'Название', description: 'Описание', priority: 'Приоритет', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный', fast: 'Разрешён fast-path', identity: 'Нужна идентификация', confirmation: 'Нужно подтверждение', searchEmpty: 'Нет совпадений. Измените запрос.', system: 'Системные намерения', scenarios: 'Сценарии', draft: 'Локальный черновик', unchanged: 'Исходная версия', changed: 'Изменено записей', valid: 'Схема и ссылки корректны', invalid: 'Исправьте ошибки', unsaved: 'Есть неприменённые правки. Примените или отмените их перед другим действием.', saved: 'Черновик сохранён только в этом браузере.', applied: 'Правки применены и сохранены локально.', storageError: 'Браузер не разрешил сохранение. Черновик доступен до закрытия экрана; экспортируйте JSON.', recovered: 'Сохранённый черновик повреждён. Загружен исходный каталог, повреждённая версия не перезаписана.', importError: 'Не удалось прочитать файл. Выберите JSON до 2 МБ.', confirmReset: 'Заменить локальный черновик исходным каталогом? Сначала экспортируйте нужные изменения.', confirmDelete: 'Удалить этот дополнительный сценарий из локального черновика?', confirmImport: 'Заменить локальный черновик импортированным каталогом?', confirm: 'Подтвердить', cancel: 'Отмена', references: 'Справочник допустимых ссылок', actions: 'Действия', slots: 'Слоты', queues: 'Очереди', irreversible: 'требует подтверждения', protected: 'Базовая запись защищена от удаления', downloaded: 'JSON подготовлен для скачивания. Серверный каталог не изменён.', more: 'Ещё ошибок', meta: 'Версия исходных данных' },
  kk: { title: 'Сценарийлер редакторы', intro: 'Каталогтың жергілікті жұмыс нұсқасы. Өзгерістер белсенді маршрутизаторға әсер етпейді: JSON файлын экспорттап, сервер әзірлеушісіне беріңіз.', note: 'Тек синтетикалық деректерді пайдаланыңыз. 40 негізгі сценарий мен 3 жүйелік ниетті жоюға болмайды.', search: 'ID, атау немесе сипаттама бойынша іздеу', add: 'Жаңа сценарий', import: 'JSON импорттау', export: 'JSON экспорттау', reset: 'Бастапқы каталог', save: 'Браузерде сақтау', apply: 'Жобаға қолдану', discard: 'Өзгерістерден бас тарту', delete: 'Сценарийді жою', json: 'Сценарийдің толық JSON нұсқасы', jsonHelp: 'Слоттар, әрекеттер, ерекшеліктер, RU/KK мысалдары мен жауаптары осы жерде өңделеді. ID өзгермейді. Басқа сценарийді таңдаудан бұрын өзгерістерді қолданыңыз.', name: 'Атауы', description: 'Сипаттамасы', priority: 'Басымдық', normal: 'Қалыпты', high: 'Жоғары', urgent: 'Шұғыл', fast: 'Fast-path рұқсат етілген', identity: 'Сәйкестендіру қажет', confirmation: 'Растау қажет', searchEmpty: 'Сәйкестік жоқ. Сұрауды өзгертіңіз.', system: 'Жүйелік ниеттер', scenarios: 'Сценарийлер', draft: 'Жергілікті жоба', unchanged: 'Бастапқы нұсқа', changed: 'Өзгертілген жазбалар', valid: 'Схема мен сілтемелер дұрыс', invalid: 'Қателерді түзетіңіз', unsaved: 'Қолданылмаған өзгерістер бар. Басқа әрекеттен бұрын оларды қолданыңыз немесе бас тартыңыз.', saved: 'Жоба тек осы браузерде сақталды.', applied: 'Өзгерістер жергілікті түрде қолданылып, сақталды.', storageError: 'Браузер сақтауға рұқсат бермеді. Жоба экран жабылғанша қолжетімді; JSON экспорттаңыз.', recovered: 'Сақталған жоба зақымдалған. Бастапқы каталог жүктелді; зақымдалған нұсқа қайта жазылмады.', importError: 'Файл оқылмады. 2 МБ-қа дейінгі JSON таңдаңыз.', confirmReset: 'Жергілікті жобаны бастапқы каталогпен ауыстыру керек пе? Қажетті өзгерістерді алдымен экспорттаңыз.', confirmDelete: 'Осы қосымша сценарийді жергілікті жобадан жою керек пе?', confirmImport: 'Жергілікті жобаны импортталған каталогпен ауыстыру керек пе?', confirm: 'Растау', cancel: 'Бас тарту', references: 'Рұқсат етілген сілтемелер анықтамалығы', actions: 'Әрекеттер', slots: 'Слоттар', queues: 'Кезектер', irreversible: 'растауды қажет етеді', protected: 'Негізгі жазбаны жоюға болмайды', downloaded: 'JSON жүктеуге дайын. Сервер каталогы өзгертілмеді.', more: 'Қалған қателер', meta: 'Бастапқы деректер нұсқасы' },
};
const issueLabels: Record<string, [string, string]> = {
  invalid_field: ['Некорректное или пустое поле', 'Қате немесе бос өріс'], invalid_document: ['Неверная структура каталога', 'Каталог құрылымы қате'], invalid_json: ['Некорректный JSON', 'JSON қате'], too_large: ['Размер превышает 2 МБ', 'Өлшемі 2 МБ-тан асады'], duplicate_id: ['ID должен быть уникальным', 'ID бірегей болуы керек'], duplicate_slug: ['Slug должен быть уникальным', 'Slug бірегей болуы керек'], required_scenario: ['Нельзя удалить базовый сценарий', 'Негізгі сценарийді жоюға болмайды'], required_system: ['Отсутствует системное намерение', 'Жүйелік ниет жоқ'], unknown_action: ['Неизвестное действие', 'Белгісіз әрекет'], unknown_slot: ['Неизвестный слот', 'Белгісіз слот'], unknown_queue: ['Неизвестная очередь', 'Белгісіз кезек'], unknown_scenario: ['Неизвестная ссылка на сценарий', 'Сценарийге сілтеме белгісіз'], confirmation_required: ['Необратимые действия требуют подтверждения', 'Қайтымсыз әрекеттер растауды қажет етеді'], duplicate_reference: ['Повторяющаяся ссылка', 'Қайталанатын сілтеме'], immutable_id: ['ID существующей записи нельзя менять', 'Қолданыстағы жазбаның ID мәнін өзгертуге болмайды'],
};
const entrySource = (catalog: CatalogDocument, id: string) => JSON.stringify(catalog.scenarios.find(item => item.scenario_id === id) ?? catalog.system_intents.find(item => item.id === id), null, 2);
type Pending = { type: 'reset' | 'delete' } | { type: 'import'; catalog: CatalogDocument } | null;

export function CatalogEditor({ language }: { language: 'ru' | 'kk' }) {
  const t = copy[language];
  const [initial] = useState(() => {
    try { return restoreCatalogDraft(localStorage.getItem(CATALOG_STORAGE_KEY), baseline, refs); }
    catch { return { catalog: structuredClone(baseline), recovered: false }; }
  });
  const [catalog, setCatalog] = useState(initial.catalog);
  const [selected, setSelected] = useState(initial.catalog.scenarios[0].scenario_id);
  const [raw, setRaw] = useState(() => entrySource(initial.catalog, initial.catalog.scenarios[0].scenario_id));
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<keyof typeof t | null>(initial.recovered ? 'recovered' : null);
  const [importIssues, setImportIssues] = useState<CatalogIssue[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const dirty = raw !== entrySource(catalog, selected);
  const protectedEntry = refs.requiredScenarioIds.includes(selected) || refs.requiredSystemIds.includes(selected);
  const validation = useMemo(() => {
    let entry: Record<string, unknown> | null = null;
    try {
      if (new TextEncoder().encode(raw).byteLength > MAX_CATALOG_BYTES) throw new CatalogValidationError([{ path: '$', code: 'too_large' }]);
      const parsed: unknown = JSON.parse(raw);
      entry = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      return { updated: replaceCatalogEntry(catalog, selected, entry, refs), entry, issues: [] as CatalogIssue[] };
    } catch (error) { return { updated: null, entry, issues: error instanceof CatalogValidationError ? error.issues : [{ path: '$', code: 'invalid_json' }] }; }
  }, [catalog, raw, selected]);
  const changedCount = catalog.scenarios.filter(item => JSON.stringify(item) !== JSON.stringify(baseline.scenarios.find(original => original.scenario_id === item.scenario_id))).length + catalog.system_intents.filter(item => JSON.stringify(item) !== JSON.stringify(baseline.system_intents.find(original => original.id === item.id))).length;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!dirty) return;
    const preventExit = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [dirty]);
  const persist = (value: CatalogDocument, message: 'saved' | 'applied' = 'saved') => {
    try { localStorage.setItem(CATALOG_STORAGE_KEY, serializeCatalog(value)); setNotice(message); }
    catch { setNotice('storageError'); }
  };
  const install = (value: CatalogDocument, id = value.scenarios[0].scenario_id) => {
    setCatalog(value); setSelected(id); setRaw(entrySource(value, id)); setPending(null); setImportIssues([]); persist(value, 'applied');
  };
  const patchEntry = (field: string, value: unknown) => { if (validation.entry) setRaw(JSON.stringify({ ...validation.entry, [field]: value }, null, 2)); };
  const choose = (id: string) => { if (dirty) { setNotice('unsaved'); return; } setSelected(id); setRaw(entrySource(catalog, id)); setPending(null); setImportIssues([]); setNotice(null); };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImportIssues([]);
    if (file.size > MAX_CATALOG_BYTES) { setNotice('importError'); return; }
    try { const imported = parseCatalog(await file.text(), refs); if (alive.current) { setPending({ type: 'import', catalog: imported }); setNotice(null); } }
    catch (error) { if (alive.current) { setNotice('importError'); if (error instanceof CatalogValidationError) setImportIssues(error.issues); } }
  };
  const confirmPending = () => {
    if (dirty) { setNotice('unsaved'); return; }
    try {
      if (pending?.type === 'reset') install(structuredClone(baseline));
      if (pending?.type === 'delete') install(removeScenario(catalog, selected, refs));
      if (pending?.type === 'import') install(pending.catalog);
    } catch (error) { if (error instanceof CatalogValidationError) setImportIssues(error.issues); setPending(null); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeCatalog(catalog)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'scenarios.local-draft.json'; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('downloaded');
  };
  const filteredScenarios = catalog.scenarios.filter(item => `${item.scenario_id} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const filteredSystem = catalog.system_intents.filter(item => `${item.id} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const issues = [...importIssues, ...validation.issues];
  return <section className="catalog-editor" aria-labelledby="catalog-title">
    <header className="catalog-intro"><h1 id="catalog-title">{t.title}</h1></header>
    <div className="catalog-toolbar">
      <button type="button" onClick={() => { const value = createScenario(catalog, refs); install(value, value.scenarios.at(-1)!.scenario_id); }} disabled={dirty}><Plus size={16} />{t.add}</button>
      <button type="button" onClick={() => fileInput.current?.click()} disabled={dirty}><FileUp size={16} />{t.import}</button>
      <input ref={fileInput} className="sr-only" tabIndex={-1} aria-label={t.import} type="file" accept="application/json,.json" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
      <button type="button" onClick={download} disabled={dirty}><Download size={16} />{t.export}</button>
      <button type="button" onClick={() => persist(catalog)} disabled={dirty}><Save size={16} />{t.save}</button>
      <button type="button" onClick={() => setPending({ type: 'reset' })} disabled={dirty}><RotateCcw size={16} />{t.reset}</button>
    </div>
    {pending && <div className="catalog-confirm" role="group" aria-label={pending.type === 'reset' ? t.confirmReset : pending.type === 'delete' ? t.confirmDelete : t.confirmImport}><p>{pending.type === 'reset' ? t.confirmReset : pending.type === 'delete' ? t.confirmDelete : t.confirmImport}</p><button type="button" disabled={dirty} onClick={confirmPending}>{t.confirm}</button><button type="button" onClick={() => setPending(null)}>{t.cancel}</button></div>}
    <p className="catalog-notice" role="status">{notice ? t[notice] : `${changedCount ? t.draft : t.unchanged}. ${t.changed}: ${changedCount}.`}</p>
    <div className="catalog-layout">
      <aside className="catalog-sidebar"><label className="catalog-search"><Search size={16} /><input aria-label={t.search} placeholder={t.search} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="catalog-list" aria-label={t.scenarios}><h3>{t.scenarios} <span>{filteredScenarios.length}/{catalog.scenarios.length}</span></h3>{filteredScenarios.map(item => <button type="button" key={item.scenario_id} aria-pressed={selected === item.scenario_id} onClick={() => choose(item.scenario_id)}><b>{item.scenario_id}</b><span>{item.name}</span></button>)}<h3>{t.system}</h3>{filteredSystem.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} onClick={() => choose(item.id)}><b>{item.id}</b><span>{item.description}</span></button>)}{filteredScenarios.length + filteredSystem.length === 0 && <p>{t.searchEmpty}</p>}</div>
      </aside>
      <div className="catalog-detail">
        <div className="catalog-entry-heading"><h3>{selected}</h3><button type="button" className="catalog-delete" disabled={protectedEntry || dirty} title={protectedEntry ? t.protected : t.delete} onClick={() => setPending({ type: 'delete' })}><Trash2 size={15} />{t.delete}</button></div>
        {typeof validation.entry?.scenario_id === 'string' && <div className="catalog-fields"><label>{t.name}<input value={typeof validation.entry.name === 'string' ? validation.entry.name : ''} onChange={event => patchEntry('name', event.target.value)} /></label><label>{t.priority}<select value={typeof validation.entry.priority === 'string' ? validation.entry.priority : ''} onChange={event => patchEntry('priority', event.target.value)}><option value="normal">{t.normal}</option><option value="high">{t.high}</option><option value="urgent">{t.urgent}</option></select></label><label className="catalog-description">{t.description}<textarea rows={3} value={typeof validation.entry.description === 'string' ? validation.entry.description : ''} onChange={event => patchEntry('description', event.target.value)} /></label><div className="catalog-flags">{(['fast_path_eligible', 'requires_identification', 'requires_confirmation'] as const).map((key, index) => <label key={key}><input type="checkbox" checked={validation.entry?.[key] === true} onChange={event => patchEntry(key, event.target.checked)} />{[t.fast, t.identity, t.confirmation][index]}</label>)}</div></div>}
        <label className="catalog-json-label" htmlFor="catalog-json">{t.json}</label><p id="catalog-json-help" className="catalog-help">{t.jsonHelp}</p>
        <textarea id="catalog-json" className="catalog-json" value={raw} onChange={event => { setRaw(event.target.value); setNotice(null); }} spellCheck={false} aria-describedby="catalog-json-help catalog-validation" aria-invalid={validation.issues.length > 0} />
        <div id="catalog-validation" className={`catalog-validation ${issues.length ? 'is-invalid' : ''}`} role="status">{issues.length ? <><strong>{t.invalid} ({issues.length})</strong><ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code>: {(issueLabels[issue.code] ?? issueLabels.invalid_field)[language === 'ru' ? 0 : 1]}</li>)}</ul>{issues.length > 8 && <span>{t.more}: {issues.length - 8}</span>}</> : t.valid}</div>
        {dirty && <p className="catalog-help">{t.unsaved}</p>}
        <div className="catalog-apply"><button type="button" className="catalog-primary" disabled={!dirty || !validation.updated} onClick={() => { if (validation.updated) install(validation.updated, selected); }}>{t.apply}</button><button type="button" disabled={!dirty} onClick={() => { setRaw(entrySource(catalog, selected)); setNotice(null); }}>{t.discard}</button></div>
        <details className="catalog-reference"><summary>{t.references}</summary><h4>{t.actions}</h4><ul>{sourceActions.actions.map(action => <li key={action.name}><code>{action.name}</code>{action.irreversible ? ` (${t.irreversible})` : ''}</li>)}</ul><h4>{t.slots}</h4><p>{sourceSlots.slots.map(slot => slot.name).join(', ')}</p><h4>{t.queues}</h4><p>{sourceActions.queues.join(', ')}</p></details>
      </div>
    </div>
  </section>;
}
