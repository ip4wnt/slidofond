'use strict';

const db = require('../db');

// Год презентации берется из поля «Когда» (usage_date) блока «Где использовалась».
// Если пользователь его не заполнил, поле заполняется автоматически:
//   1. по папке, в которой лежит презентация (файлы раскладывают по годам: «2017», «2025»);
//      смотрим саму папку и ее родителей — берем ближайшую, в имени которой есть год;
//   2. иначе — по дате изменения файла (из свойств PPTX), запасной вариант — дата создания.
// Автозаполненное значение — это просто год («2024»). Если пользователь ввел что-то свое
// («14.03.2025», «март 2025»), автоматика его не трогает, а год для выдачи извлекается из текста.
const YEAR_RE = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/;
const BARE_YEAR_RE = /^\s*((?:19|20)\d{2})\s*$/;

function yearFromText(text) {
  const m = String(text || '').match(YEAR_RE);
  return m ? Number(m[1]) : null;
}

function yearFromFolderChain(folderId) {
  let cursor = folderId;
  let guard = 0;
  while (cursor && guard++ < 64) {
    const folder = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(cursor);
    if (!folder) break;
    const y = yearFromText(folder.name);
    if (y) return y;
    cursor = folder.parent_id;
  }
  return null;
}

function yearFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  return y >= 1990 && y <= 2100 ? y : null;
}

// Год по правилам автозаполнения (без учета того, что уже введено в «Когда»).
function deriveYear(presentation) {
  const byFolder = yearFromFolderChain(presentation.folder_id);
  if (byFolder) return { year: byFolder, source: 'folder' };
  const byDate = yearFromDate(presentation.file_modified_at) || yearFromDate(presentation.file_created_at);
  if (byDate) return { year: byDate, source: 'file_date' };
  return { year: null, source: '' };
}

// Можно ли перезаписать текущее значение «Когда» автоматикой: только если оно пустое
// или само было проставлено автоматически (просто год).
function isAutoFillable(usageDate) {
  return !usageDate || BARE_YEAR_RE.test(usageDate);
}

const SELECT_ONE = 'SELECT id, folder_id, file_modified_at, file_created_at, usage_date FROM presentations WHERE id = ?';

// Заполняет «Когда» для одной презентации, если поле пустое или содержит только автогод.
// Возвращает true, если значение изменилось.
function autoFillUsageDate(presentationId) {
  const p = db.prepare(SELECT_ONE).get(presentationId);
  if (!p || !isAutoFillable(p.usage_date)) return false;
  const { year } = deriveYear(p);
  const next = year ? String(year) : '';
  if ((p.usage_date || '') === next) return false;
  db.prepare('UPDATE presentations SET usage_date = ? WHERE id = ?').run(next, p.id);
  return true;
}

// Массовое заполнение для всех активных презентаций (или одного пространства). Ручные значения не трогаем.
function autoFillAllUsageDates(spaceId) {
  const rows = spaceId
    ? db.prepare("SELECT id, folder_id, file_modified_at, file_created_at, usage_date FROM presentations WHERE status = 'active' AND space_id = ?").all(spaceId)
    : db.prepare("SELECT id, folder_id, file_modified_at, file_created_at, usage_date FROM presentations WHERE status = 'active'").all();
  const stats = { total: rows.length, byFolder: 0, byDate: 0, manual: 0, unknown: 0, changed: 0 };
  const stmt = db.prepare('UPDATE presentations SET usage_date = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of rows) {
      if (!isAutoFillable(p.usage_date)) {
        stats.manual++;
        continue;
      }
      const { year, source } = deriveYear(p);
      if (source === 'folder') stats.byFolder++;
      else if (source === 'file_date') stats.byDate++;
      else stats.unknown++;
      const next = year ? String(year) : '';
      if ((p.usage_date || '') !== next) {
        stats.changed++;
        stmt.run(next, p.id);
      }
    }
  })();
  return stats;
}

module.exports = { yearFromText, deriveYear, autoFillUsageDate, autoFillAllUsageDates };
