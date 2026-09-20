'use strict';

const db = require('../db');

// Подбирает образец стиля таблицы/графика для намерений generate_table/generate_chart,
// когда пользователь НЕ приложил собственный пример презентации-образца
// ("если не было приложено примера, то взять пример из пространства которое сейчас включено").
//
// Логика подбора (Block 1 — только lookup существующих тегов, без самой генерации):
//   1. Ищем среди презентаций активного пространства (spaceId) теги нужного contentType
//      ('table' | 'chart'), отсортированные по confidence (сначала самые надёжные —
//      родные объекты PPT, затем имитации блоками/картинки) и свежести загрузки.
//   2. Если styleReferenceQuery (текст после "в стиле X"/"по образцу X") задан и не был
//      разрешён явной ссылкой на презентацию по имени — пытаемся дополнительно сузить
//      по совпадению имени файла/описания презентации с этим текстом.
//   3. Возвращаем первый подходящий тег вместе с презентацией-источником, либо null,
//      если в пространстве вообще нет тегов нужного типа (тогда вызывающий код должен
//      сообщить пользователю, что образцов для подражания не нашлось).
//
// Функция не создаёт таблицу/график — само построение по промпту вне рамок Block 1.
function findStyleReference({ contentType, spaceId, styleReferenceQuery }) {
  if (contentType !== 'table' && contentType !== 'chart') {
    throw new Error(`Unsupported contentType for style reference lookup: ${contentType}`);
  }

  const params = [contentType];
  let nameFilter = '';
  if (styleReferenceQuery) {
    nameFilter = 'AND (p.original_filename LIKE ? OR p.summary_text LIKE ?)';
    params.push(`%${styleReferenceQuery}%`, `%${styleReferenceQuery}%`);
  }
  const spaceFilter = spaceId ? 'AND p.space_id = ?' : '';
  if (spaceId) params.push(spaceId);

  const rows = db
    .prepare(
      `SELECT t.id AS tag_id, t.shape_index, t.content_type, t.source_kind, t.chart_type,
              t.label, t.style_payload, t.confidence,
              s.id AS slide_id, s.slide_index,
              p.id AS presentation_id, p.original_filename, p.space_id
       FROM slide_content_tags t
       JOIN slides s ON s.id = t.slide_id
       JOIN presentations p ON p.id = s.presentation_id
       WHERE t.content_type = ? AND p.status = 'active' ${nameFilter} ${spaceFilter}
       ORDER BY t.confidence DESC, p.uploaded_at DESC
       LIMIT 1`
    )
    .get(...params);

  if (!rows) {
    // Если сузили по styleReferenceQuery и ничего не нашли — пробуем без сужения
    // (пользователь мог иметь в виду презентацию, которой нет в текущем пространстве,
    // либо просто описал стиль словами, а не именем файла).
    if (styleReferenceQuery) {
      return findStyleReference({ contentType, spaceId, styleReferenceQuery: '' });
    }
    return null;
  }

  let stylePayload = {};
  try {
    stylePayload = JSON.parse(rows.style_payload || '{}');
  } catch {
    stylePayload = {};
  }

  return {
    tagId: rows.tag_id,
    shapeIndex: rows.shape_index,
    contentType: rows.content_type,
    sourceKind: rows.source_kind,
    chartType: rows.chart_type,
    label: rows.label,
    stylePayload,
    confidence: rows.confidence,
    slideId: rows.slide_id,
    slideIndex: rows.slide_index,
    presentationId: rows.presentation_id,
    originalFilename: rows.original_filename,
  };
}

module.exports = { findStyleReference };
