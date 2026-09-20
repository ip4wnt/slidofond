'use strict';

// Разбирает пользовательский поисковый запрос и определяет его "намерение":
// ищет ли пользователь слайд, презентацию целиком, конкретный слайд из конкретной
// презентации, слайд/презентацию за определённый год, либо просит СГЕНЕРИРОВАТЬ
// таблицу/график по образцу стиля (см. сценарии 6-7 ниже).
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
//   6. Если запрос содержит ГЛАГОЛ-ГЕНЕРАЦИЮ ("сделай"/"создай"/"построй"/"сгенерируй"
//      и т.п.) вместе со словом "таблица"/"график"/"диаграмма" — это НАМЕРЕНИЕ
//      ГЕНЕРАЦИИ, а не поиск. intent = 'generate_table' | 'generate_chart'.
//   7. Внутри намерения генерации отдельно распознаём, есть ли явная ссылка на
//      презентацию-образец стиля ("в стиле презентации X", "по образцу Y",
//      "как в презентации Z") — тогда styleReferenceQuery заполняется текстом
//      после маркера. Если такого маркера нет, styleReferenceQuery = '' и вызывающий
//      код (search.js) обязан сам подобрать образец стиля из активного пространства
//      (см. server/services/styleReference.js) — пользователь описал это так:
//      "если не было приложено примера, то взять пример из пространства которое
//      сейчас включено".
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

// Сценарии 6-7: распознавание намерения "сгенерируй таблицу/график в таком же стиле".
const GENERATE_VERB_WORDS = [
  'сделай', 'сделать', 'создай', 'создать', 'построй', 'построить',
  'сгенерируй', 'сгенерировать', 'сделат', 'нарисуй', 'нарисовать', 'оформи',
  'оформить', 'сверстай', 'сверстать', 'сделайте', 'создайте', 'нужна', 'нужен',
];
const TABLE_NOUN_WORDS = ['таблица', 'таблицу', 'таблице', 'таблицей', 'таблицы'];
const CHART_NOUN_WORDS = [
  'график', 'графика', 'графике', 'графиком', 'диаграмма', 'диаграмму',
  'диаграмме', 'диаграммой', 'чарт',
];
// Маркеры явной ссылки на образец стиля: "в стиле X", "по образцу X", "как в презентации X", "как в X".
const STYLE_REFERENCE_RE = /(^|[^\u0430-\u044f\u0451])(?:\u0432\s+\u0441\u0442\u0438\u043b\u0435|\u043f\u043e\s+\u043e\u0431\u0440\u0430\u0437\u0446\u0443|\u043f\u043e\s+\u0448\u0430\u0431\u043b\u043e\u043d\u0443|\u043a\u0430\u043a\s+\u0432)([^\u0430-\u044f\u0451]|$)\s*(.*)$/iu;

function detectGenerationIntent(text) {
  if (!containsWord(text, GENERATE_VERB_WORDS)) return null;
  if (containsWord(text, TABLE_NOUN_WORDS)) return 'generate_table';
  if (containsWord(text, CHART_NOUN_WORDS)) return 'generate_chart';
  return null;
}

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
 *   intent: 'slide' | 'presentation' | 'generate_table' | 'generate_chart',
 *   slideQuery: string,        // текст для полнотекстового поиска по слайдам
 *   presentationQuery: string, // текст для фильтрации по названию/описанию презентации (может быть пустым)
 *   year: number | null,       // год, если упомянут в запросе
 *   styleReferenceQuery: string, // (только для generate_*) текст после "в стиле/по образцу/как в",
 *                                 пустая строка — маркер не найден, нужен автоподбор образца стиля
 *   originalQuery: string,
 * }}
 */
function parseSearchQuery(rawQuery) {
  const originalQuery = (rawQuery || '').trim();
  let working = originalQuery;

  // Сценарии 6-7: намерение генерации проверяем первым делом — оно не сочетается с
  // обычным поиском и полностью заменяет ветку slide/presentation.
  const generationIntent = detectGenerationIntent(working);
  if (generationIntent) {
    const styleMatch = working.match(STYLE_REFERENCE_RE);
    const styleReferenceQuery = styleMatch ? styleMatch[3].trim() : '';
    return {
      intent: generationIntent,
      slideQuery: '',
      presentationQuery: '',
      year: null,
      styleReferenceQuery,
      originalQuery,
    };
  }

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
      styleReferenceQuery: '',
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
      styleReferenceQuery: '',
      originalQuery,
    };
  }

  if (hasPresentationWord) {
    return {
      intent: 'presentation',
      slideQuery: '',
      presentationQuery: stripWords(working, PRESENTATION_WORDS) || working,
      year,
      styleReferenceQuery: '',
      originalQuery,
    };
  }

  // По умолчанию — поиск слайда (сохраняем прежнее поведение сервиса)
  return {
    intent: 'slide',
    slideQuery: working,
    presentationQuery: '',
    year,
    styleReferenceQuery: '',
    originalQuery,
  };
}

module.exports = { parseSearchQuery };
