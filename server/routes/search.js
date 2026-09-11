'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Экранирует спецсимволы FTS5 query syntax, оборачивая каждое слово в кавычки + добавляя * для префиксного поиска
function buildFtsQuery(q) {
  const words = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/"/g, ''));
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(' OR ');
}

// GET /api/search?q=...&spaces=1,2,3
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString();
  const spacesParam = (req.query.spaces || '').toString();
  const spaceIds = spacesParam
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!q.trim()) return res.json({ slides: [] });
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) return res.json({ slides: [] });

  const spaceFilter = spaceIds.length > 0 ? `AND p.space_id IN (${spaceIds.map(() => '?').join(',')})` : '';

  const rows = db
    .prepare(
      `SELECT s.id AS slide_id, s.slide_index, s.title, s.description,
              p.id AS presentation_id, p.original_filename, p.space_id, p.folder_id,
              bm25(slides_fts) AS rank
       FROM slides_fts
       JOIN slides s ON s.id = slides_fts.rowid
       JOIN presentations p ON p.id = s.presentation_id
       WHERE slides_fts MATCH ? AND p.status = 'active' ${spaceFilter}
       ORDER BY rank
       LIMIT 60`
    )
    .all(ftsQuery, ...spaceIds);

  const results = rows.map((r) => ({
    slideId: r.slide_id,
    presentationId: r.presentation_id,
    index: r.slide_index,
    title: r.title,
    description: r.description,
    originalFilename: r.original_filename,
    spaceId: r.space_id,
    folderId: r.folder_id,
    previewUrl: `/api/presentations/${r.presentation_id}/slides/${r.slide_index}/preview`,
  }));

  res.json({ slides: results });
});

module.exports = router;
