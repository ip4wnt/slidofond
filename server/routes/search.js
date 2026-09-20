'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parseSearchQuery } = require('../services/queryParser');
const { findStyleReference } = require('../services/styleReference');

const router = express.Router();

// Короткие служебные слова/предлоги, которые не несут смысловой нагрузки и только зашумляют
// FTS-поиск (без них "про", "из", "для" и т.п. совпадали бы со всеми документами через OR).
const STOPWORDS = new Set([
  'про', 'из', 'для', 'и', 'в', 'на', 'с', 'к', 'о', 'об', 'что', 'как', 'по', 'у', 'не', 'а', 'то', 'это',
  'такой', 'такая', 'такое', 'такие', 'какой-то', 'номер', 'за', 'с темами',
]);

// Экранирует спецсимволы FTS5 query syntax, оборачивая каждое значимое слово в кавычки + добавляя * для префиксного поиска
function buildFtsQuery(q) {
  const words = (q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/"/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(' OR ');
}

// Возвращает набор id презентаций, относящихся к указанному году, для конкретного
// пространства (или всех, если spaceId не задан). Год определяем по имени корневой
// папки в дереве презентации (в ФПГ корневые папки называются "2017".."2026"), а если
// у презентации почему-то нет "года" в пути — по дате создания/изменения файла.
function presentationIdsForYear(year, spaceId) {
  const spaceFilter = spaceId ? 'AND p.space_id = ?' : '';
  // Порядок параметров должен совпадать с порядком `?` в SQL: сначала space_id (если есть), потом root.name.
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
  const byFolderName = new Set(rows.map((r) => r.id));

  const dateSpaceFilter = spaceId ? 'AND space_id = ?' : '';
  const dateParams = spaceId ? [spaceId] : [];
  const dateRows = db
    .prepare(
      `SELECT id, file_created_at, file_modified_at FROM presentations
       WHERE status = 'active' ${dateSpaceFilter}`
    )
    .all(...dateParams);
  for (const r of dateRows) {
    const dateStr = r.file_created_at || r.file_modified_at;
    if (dateStr && new Date(dateStr).getFullYear() === year) byFolderName.add(r.id);
  }

  return byFolderName;
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
    uploadedAt: p.uploaded_at,
    fileCreatedAt: p.file_created_at,
    previewUrl: `/api/presentations/${p.id}/slides/0/preview`,
  };
}

// Ищет слайды. `presentationQuery` (если задан) дополнительно сужает результат до
// презентаций, чьё имя файла или описание содержит эту фразу. `presentationIds`
// (если задан) сужает результат до конкретного набора id (используется для фильтра по году).
function searchSlides({ slideQuery, spaceId, presentationQuery, presentationIds }) {
  const ftsQuery = buildFtsQuery(slideQuery);
  const spaceFilter = spaceId ? 'AND p.space_id = ?' : '';
  const params = [];
  let presentationFilter = '';
  if (presentationIds) {
    if (presentationIds.size === 0) return [];
    presentationFilter = `AND p.id IN (${Array.from(presentationIds).map(() => '?').join(',')})`;
  }
  let nameFilter = '';
  if (presentationQuery) {
    nameFilter = 'AND (p.original_filename LIKE ? OR p.summary_text LIKE ?)';
  }

  if (!ftsQuery) {
    // Нет отдельной темы слайда (например, запрос был чисто "слайд из презы X 2025 года") —
    // возвращаем слайды подходящих презентаций без полнотекстового ранжирования.
    if (!presentationIds && !presentationQuery) return [];
    const clauses = [`p.status = 'active'`];
    if (spaceId) { clauses.push('p.space_id = ?'); params.push(spaceId); }
    if (presentationIds) {
      clauses.push(`p.id IN (${Array.from(presentationIds).map(() => '?').join(',')})`);
      params.push(...presentationIds);
    }
    if (presentationQuery) {
      clauses.push('(p.original_filename LIKE ? OR p.summary_text LIKE ?)');
      params.push(`%${presentationQuery}%`, `%${presentationQuery}%`);
    }
    const rows = db
      .prepare(
        `SELECT s.id AS slide_id, s.slide_index, s.title, s.description,
                p.id AS presentation_id, p.original_filename, p.space_id, p.folder_id
         FROM slides s JOIN presentations p ON p.id = s.presentation_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.uploaded_at DESC, s.slide_index
         LIMIT 60`
      )
      .all(...params);
    return rows.map(slideToPublic);
  }

  const queryParams = [ftsQuery];
  if (spaceId) queryParams.push(spaceId);
  if (presentationIds) queryParams.push(...presentationIds);
  if (presentationQuery) queryParams.push(`%${presentationQuery}%`, `%${presentationQuery}%`);

  const rows = db
    .prepare(
      `SELECT s.id AS slide_id, s.slide_index, s.title, s.description,
              p.id AS presentation_id, p.original_filename, p.space_id, p.folder_id,
              bm25(slides_fts) AS rank
       FROM slides_fts
       JOIN slides s ON s.id = slides_fts.rowid
       JOIN presentations p ON p.id = s.presentation_id
       WHERE slides_fts MATCH ? AND p.status = 'active' ${spaceFilter} ${presentationFilter} ${nameFilter}
       ORDER BY rank
       LIMIT 60`
    )
    .all(...queryParams);
  return rows.map(slideToPublic);
}

// Ищет презентации целиком: по имени файла, общему описанию, и по совпадению в
// заголовках/тексте слайдов внутри неё (через slides_fts, свёрнутое до presentation_id).
function searchPresentations({ presentationQuery, spaceId, presentationIds }) {
  const clauses = [`p.status = 'active'`];
  const params = [];
  if (spaceId) { clauses.push('p.space_id = ?'); params.push(spaceId); }
  if (presentationIds) {
    if (presentationIds.size === 0) return [];
    clauses.push(`p.id IN (${Array.from(presentationIds).map(() => '?').join(',')})`);
    params.push(...presentationIds);
  }

  const ftsQuery = buildFtsQuery(presentationQuery);
  let matchingIds = null;
  if (ftsQuery) {
    const slideMatchRows = db
      .prepare(
        `SELECT DISTINCT s.presentation_id AS id
         FROM slides_fts JOIN slides s ON s.id = slides_fts.rowid
         WHERE slides_fts MATCH ?`
      )
      .all(ftsQuery);
    const nameMatchRows = db
      .prepare(
        `SELECT id FROM presentations WHERE original_filename LIKE ? OR summary_text LIKE ?`
      )
      .all(`%${presentationQuery}%`, `%${presentationQuery}%`);
    matchingIds = new Set([...slideMatchRows.map((r) => r.id), ...nameMatchRows.map((r) => r.id)]);
    if (matchingIds.size === 0) return [];
    clauses.push(`p.id IN (${Array.from(matchingIds).map(() => '?').join(',')})`);
    params.push(...matchingIds);
  }

  const rows = db
    .prepare(
      `SELECT * FROM presentations p WHERE ${clauses.join(' AND ')} ORDER BY p.uploaded_at DESC LIMIT 60`
    )
    .all(...params);
  return rows.map(presentationToPublic);
}

// GET /api/search?q=...&spaceId=1
// Логика различения намерения запроса (см. server/services/queryParser.js):
//   - "слайд ..."                              -> ищем слайды
//   - "презентация/преза ..."                  -> ищем презентации целиком
//   - "слайд ... из презы/презентации Y"       -> слайд, дополнительно отфильтрованный по презентации Y
//   - "... 2025 года"                          -> результат ограничивается презентациями за указанный год
//   - "сделай таблицу/график в стиле X"    -> generate_table/generate_chart: Block 1 лишь
//        подбирает и возвращает образец стиля (из явно указанной презентации или,
//        если она не указана, из активного пространства) — само построение таблицы/графика
//        по промпту вне рамок Block 1, будет реализовано отдельно.
// Поиск всегда ведётся в рамках ОДНОГО пространства (spaceId) — переключение пространств
// теперь находится в UI как единый активный таб, а не набор фильтров.
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString();
  const spaceId = Number(req.query.spaceId || req.query.spaces) || null;

  if (!q.trim()) return res.json({ intent: 'slide', slides: [], presentations: [] });

  const parsed = parseSearchQuery(q);

  if (parsed.intent === 'generate_table' || parsed.intent === 'generate_chart') {
    const contentType = parsed.intent === 'generate_table' ? 'table' : 'chart';
    const styleReference = findStyleReference({
      contentType,
      spaceId,
      styleReferenceQuery: parsed.styleReferenceQuery,
    });
    // Block 3: распознали намерение и подобрали образец стиля из пространства (если он там
    // есть) — сама генерация происходит через отдельный экран (POST /api/generate), потому что
    // ей ещё нужен файл Excel с данными от пользователя, которого в строке поиска нет.
    // generationSupported теперь true: search используется только чтобы сходу подсказать
    // пользователю подходящий styleReference и открыть экран генерации предзаполненным;
    // если styleReference не найден — экран генерации всё равно доступен, просто без
    // предзаполненного варианта "стиль из пространства" (пользователь приложит свой файл-донор).
    return res.json({
      intent: parsed.intent,
      slides: [],
      presentations: [],
      parsed,
      styleReference,
      generationSupported: true,
    });
  }

  const presentationIds = parsed.year !== null ? presentationIdsForYear(parsed.year, spaceId) : null;

  if (parsed.intent === 'presentation') {
    const presentations = searchPresentations({
      presentationQuery: parsed.presentationQuery,
      spaceId,
      presentationIds,
    });
    return res.json({ intent: 'presentation', slides: [], presentations, parsed });
  }

  const slides = searchSlides({
    slideQuery: parsed.slideQuery,
    spaceId,
    presentationQuery: parsed.presentationQuery,
    presentationIds,
  });
  return res.json({ intent: 'slide', slides, presentations: [], parsed });
});

module.exports = router;
