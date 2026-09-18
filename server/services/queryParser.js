'use strict';

// Разбирает пользовательский поисковый запрос и определяет его "намерение":
// ищет ли пользователь слайд, презентацию целиком, конкретный слайд из конкретной
// презентации, либо слайд/презентацию за определённый год.
//
// Правила (эвристика по ключевым словам, см. постановку задачи):
//   1. Если в запросе встречается слово "слайд"/"слайды" — это поиск СЛАЙДА.
//   2. Если встречается "преза"/"презентация"/"презентации" (и не найдено слово
//      "слайд") — это поиск ПРЕЗЕНТАЦИИ целиком.
//   3. Комбинация "слайд ... из презы/презентации ..." — пользователь ищет
//      конкретный слайд внутри конкретной презентации. В этом случае текст ДО
//      маркера "из презы/презентации" — тема слайда, текст ПОСЛЕ — название/тема
//      презентации, по которой дополнительно фильтруем результаты.
//   4. Если в запросе есть 4-значный год (2000–2099), даже без явного "из презы" —
//      результат дополнительно ограничивается презентациями, у которых год
//      загрузки/изменения совпадает. Работает как для слайдов, так и для презентаций,
//      и комбинируется с сценарием (3): "слайд такой-то 2025 года" ищет слайд
//      именно среди презентаций 2025 года.
//   5. Если ни один маркер не найден — по умолчанию считаем запрос поиском слайда
//      (сохраняет прежнее поведение сервиса).
//
// Функция ничего не знает о базе данных — она только выделяет структуру запроса.
// Дальше `search.js` использует intent/filters, чтобы построить SQL.

const SLIDE_WORDS = ['слайд', 'слайда', 'слайду', 'слайдом', 'слайде', 'слайды', 'слайдов'];
const PRESENTATION_WORDS = [
  'презентация', 'презентации', 'презентацию', 'презентацией', 'презентаций',
  'преза', 'презы', 'презу', 'презой',
];
// Маркер "из презы X" / "из презентации X" — разделяет тему слайда и презентацию-контейнер.
// \b не работает с кириллицей в JS-регулярках, поэтому границы слова заданы явно через
// отрицание класса кириллических букв.
const FROM_PRESENTATION_RE = /(^|[^а-яё])из\s+(презентации|презы|презентацию|презу)([^а-яё]|$)\s*(.*)$/iu;
// Сначала пытаемся съесть слово-спутник целиком ("года"/"году"/"г."), чтобы не оставались обрывки типа "ода".
const YEAR_RE = /(^|[^0-9])(20\d{2})(\s*(?:года|году|год|г\.))?([^0-9]|$)/iu;
// Хвостовые слова-паразиты на случай, если слово "года"/"году" стояло отдельно от числа в тексте.
const YEAR_LEFTOVER_WORDS = ['года', 'году', 'год', 'г\\.'];

function containsWord(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => new RegExp(`(^|[^а-яё])${w}([^а-яё]|$)`, 'iu').test(lower));
}

function stripWords(text, words) {
  let result = text;
  for (const w of words) {
    result = result.replace(new RegExp(`(^|[^а-яё])${w}([^а-яё]|$)`, 'giu'), ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} rawQuery
 * @returns {{
 *   intent: 'slide' | 'presentation',
 *   slideQuery: string,        // текст для полнотекстового поиска по слайдам
 *   presentationQuery: string, // текст для фильтрации по названию/описанию презентации (может быть пустым)
 *   year: number | null,       // год, если упомянут в запросе
 *   originalQuery: string,
 * }}
 */
function parseSearchQuery(rawQuery) {
  const originalQuery = (rawQuery || '').trim();
  let working = originalQuery;

  // Год — извлекаем и убираем из текста, чтобы не мешал полнотекстовому поиску
  let year = null;
  const yearMatch = working.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[2]);
    working = working
      .replace(YEAR_RE, '$1 $4')
      .replace(/\s+/g, ' ')
      .trim();
    working = stripWords(working, YEAR_LEFTOVER_WORDS);
  }

  // Сценарий 3: "слайд ... из презы/презентации ..."
  const fromMatch = working.match(FROM_PRESENTATION_RE);
  if (fromMatch) {
    const beforeText = working.slice(0, fromMatch.index).trim();
    const presentationQuery = fromMatch[4].trim();
    const slideQuery = stripWords(beforeText, SLIDE_WORDS) || beforeText;
    return {
      intent: 'slide',
      slideQuery: slideQuery || presentationQuery,
      presentationQuery,
      year,
      originalQuery,
    };
  }

  const hasSlideWord = containsWord(working, SLIDE_WORDS);
  const hasPresentationWord = containsWord(working, PRESENTATION_WORDS);

  if (hasSlideWord) {
    return {
      intent: 'slide',
      slideQuery: stripWords(working, SLIDE_WORDS) || working,
      presentationQuery: '',
      year,
      originalQuery,
    };
  }

  if (hasPresentationWord) {
    return {
      intent: 'presentation',
      slideQuery: '',
      presentationQuery: stripWords(working, PRESENTATION_WORDS) || working,
      year,
      originalQuery,
    };
  }

  // По умолчанию — поиск слайда (сохраняем прежнее поведение сервиса)
  return {
    intent: 'slide',
    slideQuery: working,
    presentationQuery: '',
    year,
    originalQuery,
  };
}

module.exports = { parseSearchQuery };
