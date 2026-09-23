import { readAffect } from '../affect-model';
const labels = {
  ru: { neutral: 'Нейтрально', concerned: 'Беспокойство', frustrated: 'Раздражение', angry: 'Гнев', sad: 'Грусть', positive: 'Позитивно', empathetic: 'Эмпатичный', calm: 'Спокойный', reassuring: 'Поддерживающий', concise: 'Краткий', audio: 'Аудио', text: 'Текст', multimodal: 'Аудио + текст' },
  kk: { neutral: 'Бейтарап', concerned: 'Алаңдау', frustrated: 'Реніш', angry: 'Ашу', sad: 'Мұң', positive: 'Позитивті', empathetic: 'Жанашыр', calm: 'Сабырлы', reassuring: 'Қолдаушы', concise: 'Қысқа', audio: 'Аудио', text: 'Мәтін', multimodal: 'Аудио + мәтін' },
};
export function AffectPanel({trace, language}: {trace: unknown; language: 'ru'|'kk'}) {
  const affect = readAffect(trace); const t = labels[language]; const ru = language === 'ru';
  return <section className="sv-section"><h3>{ru ? 'Эмоция и тон ответа' : 'Эмоция және жауап реңкі'}</h3>
    {affect ? <dl className="sv-slots">
      <div><dt>{ru ? 'Эмоция клиента' : 'Клиент эмоциясы'}</dt><dd>{affect.emotion ? t[affect.emotion] : '∅'}</dd></div>
      <div><dt>{ru ? 'Тон ответа' : 'Жауап реңкі'}</dt><dd>{affect.tone ? t[affect.tone] : '∅'}</dd></div>
      <div><dt>{ru ? 'Источник' : 'Дереккөзі'}</dt><dd>{affect.source ? t[affect.source] : '∅'}</dd></div>
      {affect.confidence !== null && <div><dt>{ru ? 'Оценка модели' : 'Модель бағасы'}</dt><dd>{affect.confidence.toFixed(2)}</dd></div>}
    </dl> : <p className="sv-muted">{ru ? 'Сервер не передал оценку эмоции или тон ответа.' : 'Сервер эмоция бағасын немесе жауап реңкін жібермеді.'}</p>}
    <p className="sv-help">{ru ? 'Оценка модели может ошибаться. Интерфейс не определяет эмоции самостоятельно и не меняет страховые решения на их основе.' : 'Модель бағасы қате болуы мүмкін. Интерфейс эмоцияны өзі анықтамайды және оған сүйеніп сақтандыру шешімін өзгертпейді.'}</p>
  </section>;
}
