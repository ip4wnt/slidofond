'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR } = require('../utils/paths');
const { buildPresentation } = require('../services/builder');

const router = express.Router();

const EXPIRY_HOURS = 24;

function resolveSlideSources(slideIds) {
  if (!slideIds || slideIds.length === 0) throw new Error('Список слайдов пуст');
  const placeholders = slideIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id, s.slide_index, p.stored_filename, p.original_filename
       FROM slides s JOIN presentations p ON p.id = s.presentation_id
       WHERE s.id IN (${placeholders}) AND p.status = 'active'`
    )
    .all(...slideIds);

  const byId = new Map(rows.map((r) => [r.id, r]));
  // сохраняем порядок, заданный пользователем в slideIds
  return slideIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({ path: path.join(UPLOADS_DIR, r.stored_filename), index: r.slide_index }));
}

// Сборка презентации из списка выбранных слайдов (по их id в БД)
router.post('/', requireAuth, async (req, res) => {
  const { slideIds, queryText } = req.body || {};
  if (!Array.isArray(slideIds) || slideIds.length === 0) {
    return res.status(400).json({ error: 'Передайте непустой список slideIds' });
  }
  try {
    const items = resolveSlideSources(slideIds);
    if (items.length === 0) return res.status(404).json({ error: 'Слайды не найдены' });

    const outputPath = await buildPresentation(items);
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000).toISOString();

    const info = db
      .prepare(
        `INSERT INTO export_jobs (requested_by, query_text, file_path, slide_count, status, expires_at)
         VALUES (?, ?, ?, ?, 'done', ?)`
      )
      .run(req.user.id, queryText || '', outputPath, items.length, expiresAt);

    res.status(201).json({
      id: info.lastInsertRowid,
      downloadUrl: `/api/build/${info.lastInsertRowid}/download`,
      slideCount: items.length,
      expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/download', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const job = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Сборка не найдена' });
  if (new Date(job.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Срок хранения файла истёк' });
  }
  if (!fs.existsSync(job.file_path)) return res.status(404).json({ error: 'Файл не найден на диске' });
  res.download(job.file_path, 'presentation.pptx');
});

module.exports = router;
