'use strict';

const express = require('express');
const db = require('../db');
const { yearFromText } = require('../services/yearResolver');
const { requireAuth } = require('../middleware/auth');
const { parseSearchQuery } = require('../services/queryParser');
const { findStyleReference } = require('../services/styleReference');

const router = express.Router();

// Короткие служебные слова/предлоги, которые не несут смысловой нагрузки и только зашумляют
// FTS-поиск (без них "про", "из", "для" и т.п. совпадали бы со всеми документами через OR).
const STOPWORDS = new Set([
  'про', 'из', 'для', 'и', 'в', 'на', 'с', 'к', 'о', 'об', 'что', 'как', 'по', 'у', 'не', 'а', 'то', 'это',
  'такой', 'такая', 'такое', 'такие', 'какой-то', 'номер', 'за', 'с темами', 'где', 'кто', 'который', 'которая',
  'выступал', 'выступала', 'выступление', 'выступления', 'доклад', 'доклада', 'докладчик', 'спикер',
  'презентация', 'презентации', 'презентацию', 'преза', 'презы', 'слайд', 'слайды', 'слайда', 'слайдов',
]);

const USAGE_COLUMNS = '{usage_event usage_speaker usage_place usage_date usage_notes}';

// Разбивает запрос на значимые слова (без служебных и однобуквенных), очищая кавычки FTS.
function significantWords(q) {
  return (q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/["'«»()]/g, '').replace(/[.,;:!?]+$/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
}

// Экранирует спецсимволы FTS5 query syntax, оборачивая каждое значимое слово в кавычки + добавляя * для префиксного поиска
function buildFtsQuery(words) {
  if (!words || words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
}

// Префиксный поиск по словоформам: «Иванова» в запросе должна находить «Иванов» в блоке использования.
// Для слов длиннее 5 букв отбрасываем окончание (до 2 букв), чтобы совпадали падежи.
function stemForPrefix(word) {
  const w = word.replace(/"/g, '');
  if (w.length >= 7) return w.slice(0, w.length - 2);
  if (w.length >= 5) return w.slice(0, w.length - 1);
  return w;
}

function buildPrefixQuery(words, columns) {
  if (!words || words.length === 0) return null;
  const prefix = columns ? `${columns}:` : '';
  return words.map((w) => `${prefix}"${stemForPrefix(w)}"*`).join(' OR ');
}

// Возвращает набор id презентаций, относящихся к указанному году, для конкретного
// пространства (или всех, если spaceId не задан). Год определяем по имени корневой
// папки в дереве презентации (в ФПГ корневые папки называются "2017".."2026"), а если
// у презентации почему-то нет "года" в пути — по дате создания/изменения файла или по
// дате в блоке «Где использовалась».
function presentationIdsForYear(year, spaceId) {
  const spaceFilter = spaceId ? 'AND p.space_id = ?' : '';
  const params = spaceId ? [spaceId, String(year)] : [String(year)];
  const rows = db
    .prepare(
      `WITH RECURSIVE folder_root(id, root_id) AS (
         SELECT id, id FROM folders WHERE parent_id IS NULL
         UNION ALL
         SELECT f.id, fr.root_id FROM folders f
         JOIN folder_root fr ON f.parent_id = fr.id
       )
       SELECT DISTINCT p.id
       FROM presentations p
       JOIN folder_root fr ON fr.id = p.folder_id
       JOIN folders root ON root.id = fr.root_id
       WHERE p.status = 'active' ${spaceFilter} AND root.name = ?`
    )
    .all(...params);
  const ids = new Set(rows.map((r) => r.id));

  const dateSpaceFilter = spaceId ? 'AND space_id = ?' : '';
  const dateParams = spaceId ? [spaceId] : [];
  const dateRows = db
    .prepare(
      `SELECT id, file_created_at, file_modified_at, usage_date FROM presentations
       WHERE status = 'active' ${dateSpaceFilter}`
    )
    .all(...dateParams);
  for (const r of dateRows) {
    if (r.usage_date && r.usage_date.includes(String(year))) {
      ids.add(r.id);
      continue;
    }
    const dateStr = r.file_created_at || r.file_modified_at;
    if (dateStr && new Date(dateStr).getFullYear() === year) ids.add(r.id);
  }
  return ids;
}

function usageToPublic(p) {
  return {
    event: p.usage_event || '',
    speaker: p.usage_speaker || '',
    place: p.usage_place || '',
    date: p.usage_date || '',
    notes: p.usage_notes || '',
  };
}

function slideToPublic(r) {
  return {
    type: 'slide',
    slideId: r.slide_id,
    presentationId: r.presentation_id,
    index: r.slide_index,
    title: r.title,
    description: r.description,
    originalFilename: r.original_filename,
    spaceId: r.space_id,
    folderId: r.folder_id,
    year: yearFromText(r.usage_date),
    usage: usageToPublic(r),
    contextMatched: !!r.context_matched,
    previewUrl: `/api/presentations/${r.presentation_id}/slides/${r.slide_index}/preview`,
  };
}

function presentationToPublic(p) {
  return {
    type: 'presentation',
    presentationId: p.id,
    originalFilename: p.original_filename,
    summaryText: p.summary_text,
    slideCount: p.slide_count,
    spaceId: p.space_id,
    folderId: p.folder_id,
    year: yearFromText(p.usage_date),
    uploadedAt: p.uploaded_at,
    fileCreatedAt: p.file_created_at,
    usage: usageToPublic(p),
    contextMatched: !!p.context_matched,
    previewUrl: `/api/presentations/${p.id}/slides/0/preview`,
  };
}

// Презентации пространства, у которых блок «Где использовалась» совпадает с FTS-запросом.
function usageMatches(ftsQuery, spaceId) {
  if (!ftsQuery) return new Map();
  const params = [ftsQuery];
  if (spaceId) params.push(spaceId);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT p.id, bm25(presentations_fts) AS rank
         FROM presentations_fts JOIN presentations p ON p.id = presentations_fts.rowid
         WHERE presentations_fts MATCH ? AND p.status = 'active' ${spaceId ? 'AND p.space_id = ?' : ''}`
      )
      .all(...params);
  } catch (e) {
    rows = [];
  }
  return new Map(rows.map((r) => [r.id, r.rank]));
}

// Есть ли хоть один слайд пространства, где встречается слово (по префиксу).
function wordMatchesSlides(word, spaceId) {
  const params = [buildPrefixQuery([word])];
  if (spaceId) params.push(spaceId);
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM slides_fts JOIN slides s ON s.id = slides_fts.rowid
         JOIN presentations p ON p.id = s.presentation_id
         WHERE slides_fts MATCH ? AND p.status = 'active' ${spaceId ? 'AND p.space_id = ?' : ''} LIMIT 1`
      )
      .get(...params);
    return !!row;
  } catch (e) {
    return false;
  }
}

// Делит слова запроса на тему слайда и контекст использования.
// Контекстным считаем слово, которое встречается в блоке «Где использовалась» хотя бы одной
// презентации пространства и при этом не встречается в тексте слайдов — так «Иванов», «форум»,
// «Казань» сужают выборку до нужных презентаций, а «грант» остается темой слайда.
function splitTopicAndContext(words, spaceId) {
  const topicWords = [];
  const contextWords = [];
  let contextIds = null;
  for (const word of words) {
    const matches = usageMatches(buildPrefixQuery([word], USAGE_COLUMNS), spaceId);
    if (matches.size > 0 && !wordMatchesSlides(word, spaceId)) {
      contextWords.push(word);
      const ids = new Set(matches.keys());
      if (contextIds === null) contextIds = ids;
      else {
        const intersection = new Set([...contextIds].filter((id) => ids.has(id)));
        // Если пересечение пустое (слова относятся к разным презентациям) — оставляем объединение.
        contextIds = intersection.size > 0 ? intersection : new Set([...contextIds, ...ids]);
      }
    } else {
      topicWords.push(word);
    }
  }
  return { topicWords, contextWords, contextIds: contextIds || new Set() };
}

function intersectSets(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter((id) => b.has(id)));
}

// Ищет слайды. `presentationQuery` (если задан) дополнительно сужает результат до
// презентаций, чьё имя файла, описание или блок использования содержит эту фразу.
// `presentationIds` (если задан) сужает результат до конкретного набора id (фильтр по году).
function searchSlides({ slideQuery, spaceId, presentationQuery, presentationIds }) {
  const words = significantWords(slideQuery);
  const { topicWords, contextWords, contextIds } = splitTopicAndContext(words, spaceId);

  // Явная ссылка на презентацию («из презы X») — ищем X по имени, описанию и блоку использования.
  let explicitIds = null;
  if (presentationQuery) {
    const pq = buildPrefixQuery(significantWords(presentationQuery));
    const byFts = usageMatches(pq, spaceId);
    const byLike = db
      .prepare(`SELECT id FROM presentations WHERE status = 'active' ${spaceId ? 'AND space_id = ?' : ''} AND (original_filename LIKE ? OR summary_text LIKE ?)`)
      .all(...(spaceId ? [spaceId] : []), `%${presentationQuery}%`, `%${presentationQuery}%`);
    explicitIds = new Set([...byFts.keys(), ...byLike.map((r) => r.id)]);
  }

  let allowedIds = presentationIds || null;
  if (explicitIds) allowedIds = intersectSets(allowedIds, explicitIds);
  const contextOnly = contextWords.length > 0 ? contextIds : null;

  const run = (restrictIds) => {
    if (restrictIds && restrictIds.size === 0) return [];
    const clauses = [`p.status = 'active'`];
    const params = [];
    const contextMark = contextIds.size > 0 ? `CASE WHEN p.id IN (${[...contextIds].map(() => '?').join(',')}) THEN 1 ELSE 0 END` : '0';
    const contextParams = [...contextIds];
    if (spaceId) { clauses.push('p.space_id = ?'); params.push(spaceId); }
    if (restrictIds) { clauses.push(`p.id IN (${[...restrictIds].map(() => '?').join(',')})`); params.push(...restrictIds); }

    const ftsQuery = buildPrefixQuery(topicWords);
    if (!ftsQuery) {
      // Темы нет (запрос целиком про контекст: «выступление Иванова на форуме») —
      // отдаем слайды подходящих презентаций по порядку, без полнотекстового ранжирования.
      if (!restrictIds) return [];
      return db
        .prepare(
          `SELECT s.id AS slide_id, s.slide_index, s.title, s.description,
                  p.id AS presentation_id, p.original_filename, p.space_id, p.folder_id,
                  p.usage_event, p.usage_speaker, p.usage_place, p.usage_date, p.usage_notes,
                  ${contextMark} AS context_matched
           FROM slides s JOIN presentations p ON p.id = s.presentation_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY p.uploaded_at DESC, s.slide_index
           LIMIT 60`
        )
        .all(...contextParams, ...params)
        .map(slideToPublic);
    }
    // Контекстные совпадения поднимаем наверх, внутри — по релевантности текста слайда.
    return db
      .prepare(
        `SELECT s.id AS slide_id, s.slide_index, s.title, s.description,
                p.id AS presentation_id, p.original_filename, p.space_id, p.folder_id,
                p.usage_event, p.usage_speaker, p.usage_place, p.usage_date, p.usage_notes,
                ${contextMark} AS context_matched,
                bm25(slides_fts, 5.0, 1.0, 3.0) AS rank
         FROM slides_fts
         JOIN slides s ON s.id = slides_fts.rowid
         JOIN presentations p ON p.id = s.presentation_id
         WHERE slides_fts MATCH ? AND ${clauses.join(' AND ')}
         ORDER BY context_matched DESC, rank
         LIMIT 60`
      )
      .all(...contextParams, ftsQuery, ...params)
      .map(slideToPublic);
  };

  // Сначала строго внутри презентаций, подходящих по контексту; если там пусто — без сужения,
  // но с подъемом контекстных совпадений в ранжировании.
  const strict = run(intersectSets(allowedIds, contextOnly));
  if (strict.length > 0 || !contextOnly) return { slides: strict, topicWords, contextWords };
  return { slides: run(allowedIds), topicWords, contextWords };
}

// Ищет презентации целиком: по имени файла, описанию, блоку «Где использовалась» и по
// совпадению в тексте слайдов внутри неё. Совпадения по самой презентации идут первыми.
function searchPresentations({ presentationQuery, spaceId, presentationIds }) {
  const words = significantWords(presentationQuery);
  const clauses = [`p.status = 'active'`];
  const params = [];
  if (spaceId) { clauses.push('p.space_id = ?'); params.push(spaceId); }
  if (presentationIds) {
    if (presentationIds.size === 0) return { presentations: [], topicWords: words, contextWords: [] };
    clauses.push(`p.id IN (${[...presentationIds].map(() => '?').join(',')})`);
    params.push(...presentationIds);
  }

  const ftsQuery = buildPrefixQuery(words);
  if (!ftsQuery) {
    const rows = db.prepare(`SELECT *, 0 AS context_matched FROM presentations p WHERE ${clauses.join(' AND ')} ORDER BY p.uploaded_at DESC LIMIT 60`).all(...params);
    return { presentations: rows.map(presentationToPublic), topicWords: [], contextWords: [] };
  }

  const metaRank = usageMatches(ftsQuery, spaceId); // имя файла + описание + блок использования
  const usageOnly = usageMatches(buildPrefixQuery(words, USAGE_COLUMNS), spaceId);
  let slideCounts = new Map();
  try {
    slideCounts = new Map(
      db
        .prepare(
          `SELECT s.presentation_id AS id, COUNT(*) AS c
           FROM slides_fts JOIN slides s ON s.id = slides_fts.rowid
           WHERE slides_fts MATCH ? GROUP BY s.presentation_id`
        )
        .all(ftsQuery)
        .map((r) => [r.id, r.c])
    );
  } catch (e) {
    slideCounts = new Map();
  }
  const candidateIds = new Set([...metaRank.keys(), ...slideCounts.keys()]);
  if (candidateIds.size === 0) return { presentations: [], topicWords: words, contextWords: [] };
  clauses.push(`p.id IN (${[...candidateIds].map(() => '?').join(',')})`);
  params.push(...candidateIds);

  const rows = db.prepare(`SELECT * FROM presentations p WHERE ${clauses.join(' AND ')}`).all(...params);
  const score = (p) => {
    let s = 0;
    if (usageOnly.has(p.id)) s += 100; // явное попадание в контекст использования
    if (metaRank.has(p.id)) s += 50 - Math.max(-20, metaRank.get(p.id)); // bm25 отрицательный: чем меньше, тем лучше
    s += Math.min(30, (slideCounts.get(p.id) || 0) * 3);
    return s;
  };
  rows.sort((a, b) => score(b) - score(a) || (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
  const contextWords = usageOnly.size ? words.filter((w) => usageMatches(buildPrefixQuery([w], USAGE_COLUMNS), spaceId).size > 0) : [];
  return {
    presentations: rows.slice(0, 60).map((p) => presentationToPublic({ ...p, context_matched: usageOnly.has(p.id) ? 1 : 0 })),
    topicWords: words.filter((w) => !contextWords.includes(w)),
    contextWords,
  };
}

// GET /api/search?q=...&spaceId=1&mode=slide|presentation
// Режим задается кнопками под строкой поиска («Найти слайд» / «Найти презентацию»); если он не
// передан, намерение определяется по тексту (см. server/services/queryParser.js). Дополнительно:
//   - "... 2025 года"                     -> результат ограничивается презентациями за указанный год
//   - "слайд ... из презы/презентации Y"  -> слайд, отфильтрованный по презентации Y
//   - слова, совпадающие с блоком «Где использовалась» (докладчик, площадка, событие), сужают
//     выборку до этих презентаций, остальные слова ищутся как тема слайда
//   - "сделай таблицу/график в стиле X"   -> generate_table/generate_chart (экран генерации)
// Поиск всегда ведётся в рамках ОДНОГО пространства (spaceId).
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString();
  const spaceId = Number(req.query.spaceId || req.query.spaces) || null;
  const mode = req.query.mode === 'presentation' || req.query.mode === 'slide' ? req.query.mode : null;

  if (!q.trim()) return res.json({ intent: mode || 'slide', slides: [], presentations: [] });

  const parsed = parseSearchQuery(q);

  if (parsed.intent === 'generate_table' || parsed.intent === 'generate_chart') {
    const contentType = parsed.intent === 'generate_table' ? 'table' : 'chart';
    const styleReference = findStyleReference({ contentType, spaceId, styleReferenceQuery: parsed.styleReferenceQuery });
    return res.json({ intent: parsed.intent, slides: [], presentations: [], parsed, styleReference, generationSupported: true });
  }

  const presentationIds = parsed.year !== null ? presentationIdsForYear(parsed.year, spaceId) : null;
  const intent = mode || parsed.intent;

  if (intent === 'presentation') {
    const query = mode && parsed.intent !== 'presentation' ? (parsed.slideQuery || parsed.presentationQuery) : parsed.presentationQuery;
    const result = searchPresentations({ presentationQuery: query, spaceId, presentationIds });
    return res.json({ intent: 'presentation', slides: [], presentations: result.presentations, parsed, topicWords: result.topicWords, contextWords: result.contextWords });
  }

  const slideQuery = parsed.intent === 'presentation' ? parsed.presentationQuery : parsed.slideQuery;
  const result = searchSlides({ slideQuery, spaceId, presentationQuery: parsed.intent === 'presentation' ? '' : parsed.presentationQuery, presentationIds });
  return res.json({ intent: 'slide', slides: result.slides, presentations: [], parsed, topicWords: result.topicWords, contextWords: result.contextWords });
});

module.exports = router;
