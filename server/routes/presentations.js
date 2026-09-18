'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { UPLOADS_DIR, PREVIEWS_DIR } = require('../utils/paths');
const { analyzePresentation } = require('../services/pptxAnalyzer');
const { renderPreviews, previewPath } = require('../services/renderer');

const router = express.Router();

const ALLOWED_EXT = new Set(['.pptx', '.ppt', '.odp', '.pdf']);

// Multer/busboy отдают originalname как latin1-декодированную строку байт multipart-заголовка,
// даже если браузер прислал имя в UTF-8. Перекодируем обратно, чтобы кириллица и другие
// не-ASCII символы отображались корректно, а не как "кракозябры".
function fixFilenameEncoding(name) {
  if (!name) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // Buffer.from(...).toString() не бросает исключений на некорректных последовательностях —
    // используем эвристику: если после перекодировки нет символов "replacement character",
    // считаем результат правильным.
    if (!fixed.includes('\uFFFD')) return fixed;
    return name;
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.originalname = fixFilenameEncoding(file.originalname);
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Поддерживаются файлы форматов: .pptx, .ppt, .odp, .pdf'));
    }
    cb(null, true);
  },
});

function toPublic(p) {
  return {
    id: p.id,
    folderId: p.folder_id,
    spaceId: p.space_id,
    originalFilename: p.original_filename,
    fileExt: p.file_ext,
    fileSizeBytes: p.file_size_bytes,
    slideCount: p.slide_count,
    uploadedBy: p.uploaded_by,
    uploadedByName: p.uploaded_by_name,
    uploadedAt: p.uploaded_at,
    fileCreatedAt: p.file_created_at,
    fileModifiedAt: p.file_modified_at,
    summaryText: p.summary_text,
    summaryStatus: p.summary_status,
    errorMessage: p.error_message || null,
  };
}

function slideToPublic(s) {
  return {
    id: s.id,
    presentationId: s.presentation_id,
    index: s.slide_index,
    title: s.title,
    description: s.description,
    descriptionEdited: !!s.description_edited,
    previewUrl: `/api/presentations/${s.presentation_id}/slides/${s.slide_index}/preview`,
  };
}

// Карта допустимых полей сортировки списка презентаций в папке
const PRESENTATION_SORT_COLUMNS = {
  name: 'original_filename COLLATE NOCASE',
  date: 'uploaded_at',
  size: 'file_size_bytes',
};

// Список презентаций в папке. Поддерживает sortBy=name|date|size и sortOrder=asc|desc (по умолчанию — дата загрузки, убывание).
router.get('/', requireAuth, (req, res) => {
  const folderId = Number(req.query.folderId);
  if (!folderId) return res.status(400).json({ error: 'Укажите folderId' });
  const sortColumn = PRESENTATION_SORT_COLUMNS[req.query.sortBy] || 'uploaded_at';
  const sortDir = req.query.sortOrder === 'asc' ? 'ASC' : req.query.sortOrder === 'desc' ? 'DESC' : (req.query.sortBy ? 'ASC' : 'DESC');
  const rows = db
    .prepare(`SELECT * FROM presentations WHERE folder_id = ? AND status = 'active' ORDER BY ${sortColumn} ${sortDir}`)
    .all(folderId);
  res.json(rows.map(toPublic));
});

// Детали одной презентации + список слайдов
router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT * FROM presentations WHERE id = ? AND status = 'active'").get(id);
  if (!p) return res.status(404).json({ error: 'Презентация не найдена' });
  const slides = db
    .prepare('SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index')
    .all(id);
  res.json({ ...toPublic(p), slides: slides.map(slideToPublic) });
});

// Превью слайда в JPEG
router.get('/:id/slides/:index/preview', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const index = Number(req.params.index);
  const filePath = previewPath(id, index);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Превью ещё не готово или не найдено' });
  }
  res.sendFile(filePath);
});

// Скачивание оригинального файла презентации
router.get('/:id/download', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT * FROM presentations WHERE id = ? AND status = 'active'").get(id);
  if (!p) return res.status(404).json({ error: 'Презентация не найдена' });
  const filePath = path.join(UPLOADS_DIR, p.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден на диске' });
  res.download(filePath, p.original_filename);
});

// Загрузка новой презентации — editor/admin
router.post('/', requireAuth, requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const folderId = Number(req.body.folderId);
  const spaceId = Number(req.body.spaceId);
  if (!folderId || !spaceId) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'Укажите folderId и spaceId' });
  }
  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND space_id = ?').get(folderId, spaceId);
  if (!folder) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'Папка не найдена в указанном пространстве' });
  }

  const stat = fs.statSync(req.file.path);
  const ext = path.extname(req.file.originalname).toLowerCase();

  const info = db
    .prepare(
      `INSERT INTO presentations
      (folder_id, space_id, original_filename, stored_filename, file_ext, file_size_bytes,
       uploaded_by, uploaded_by_name, file_created_at, file_modified_at, summary_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`
    )
    .run(
      folderId,
      spaceId,
      req.file.originalname,
      req.file.filename,
      ext,
      stat.size,
      req.user.id,
      req.user.display_name,
      stat.birthtime ? stat.birthtime.toISOString() : null,
      stat.mtime ? stat.mtime.toISOString() : null
    );

  const presentationId = info.lastInsertRowid;
  res.status(201).json(toPublic(db.prepare('SELECT * FROM presentations WHERE id = ?').get(presentationId)));

  // Асинхронная обработка: не блокируем ответ клиенту
  processPresentationAsync(presentationId, req.file.path).catch((err) => {
    console.error(`[presentations] Ошибка обработки #${presentationId}:`, err.message);
    db.prepare("UPDATE presentations SET summary_status = 'error', error_message = ? WHERE id = ?").run(
      err.message || 'Неизвестная ошибка при анализе файла',
      presentationId
    );
  });
});

async function processPresentationAsync(presentationId, filePath) {
  const analysis = await analyzePresentation(filePath);

  const insertSlide = db.prepare(
    `INSERT INTO slides (presentation_id, slide_index, title, text_content, description)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((slides) => {
    for (const s of slides) {
      insertSlide.run(presentationId, s.index, s.title, s.text_content, s.description);
    }
  });
  tx(analysis.slides);

  db.prepare(
    `UPDATE presentations SET slide_count = ?, summary_text = ?, summary_status = 'done',
     file_created_at = COALESCE(?, file_created_at), file_modified_at = COALESCE(?, file_modified_at)
     WHERE id = ?`
  ).run(
    analysis.slide_count,
    analysis.summary_text,
    analysis.file_created_at,
    analysis.file_modified_at,
    presentationId
  );

  // Рендерим превью слайдов в JPEG (может занять время для больших презентаций).
  // LibreOffice headless иногда падает с первой попытки (блокировка профиля при
  // параллельном запуске) — при ошибке пробуем ещё раз перед тем как сдаться.
  // Если и вторая попытка не удалась — анализ текста и описания всё равно готовы, но статус
  // переводим в 'error' с понятным сообщением о причине — чтобы отсутствие превью не оставалось
  // незамеченным для пользователя.
  try {
    await renderPreviews(presentationId, filePath);
  } catch (err) {
    console.error(`[presentations] Ошибка рендеринга превью #${presentationId} (попытка 1):`, err.message);
    try {
      await renderPreviews(presentationId, filePath);
    } catch (err2) {
      console.error(`[presentations] Ошибка рендеринга превью #${presentationId} (попытка 2):`, err2.message);
      db.prepare("UPDATE presentations SET summary_status = 'error', error_message = ? WHERE id = ?").run(
        `Не удалось создать превью слайдов: ${err2.message}`,
        presentationId
      );
    }
  }
}

// Редактирование описания всей презентации — editor/admin (любой презентации)
router.patch('/:id/summary', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT * FROM presentations WHERE id = ? AND status = 'active'").get(id);
  if (!p) return res.status(404).json({ error: 'Презентация не найдена' });
  const { summaryText } = req.body || {};
  if (summaryText === undefined) return res.status(400).json({ error: 'Укажите summaryText' });
  db.prepare('UPDATE presentations SET summary_text = ? WHERE id = ?').run(summaryText, id);
  res.json(toPublic(db.prepare('SELECT * FROM presentations WHERE id = ?').get(id)));
});

// Перемещение презентации в другую папку — editor/admin
router.patch('/:id/move', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT * FROM presentations WHERE id = ? AND status = 'active'").get(id);
  if (!p) return res.status(404).json({ error: 'Презентация не найдена' });
  const { folderId } = req.body || {};
  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND space_id = ?').get(folderId, p.space_id);
  if (!folder) return res.status(400).json({ error: 'Папка не найдена в этом пространстве' });
  db.prepare('UPDATE presentations SET folder_id = ? WHERE id = ?').run(folderId, id);
  res.json({ ok: true });
});

// Удаление — admin может удалить любую, editor только свою
router.delete('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare("SELECT * FROM presentations WHERE id = ? AND status = 'active'").get(id);
  if (!p) return res.status(404).json({ error: 'Презентация не найдена' });
  const isOwner = p.uploaded_by === req.user.id;
  if (req.user.role !== 'admin' && !isOwner) {
    return res.status(403).json({ error: 'Удалять можно только загруженные вами презентации' });
  }
  db.prepare('DELETE FROM presentations WHERE id = ?').run(id);
  const filePath = path.join(UPLOADS_DIR, p.stored_filename);
  fs.rmSync(filePath, { force: true });
  fs.rmSync(path.join(PREVIEWS_DIR, String(id)), { recursive: true, force: true });
  res.json({ ok: true });
});

module.exports = router;
