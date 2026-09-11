'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function toPublic(f) {
  return { id: f.id, spaceId: f.space_id, parentId: f.parent_id, name: f.name, sortOrder: f.sort_order };
}

// Дерево папок для пространства
router.get('/', requireAuth, (req, res) => {
  const spaceId = Number(req.query.spaceId);
  if (!spaceId) return res.status(400).json({ error: 'Укажите spaceId' });
  const rows = db
    .prepare('SELECT * FROM folders WHERE space_id = ? ORDER BY sort_order, name')
    .all(spaceId);
  res.json(rows.map(toPublic));
});

router.post('/', requireAuth, requireRole('editor'), (req, res) => {
  const { spaceId, parentId, name } = req.body || {};
  if (!spaceId || !name) return res.status(400).json({ error: 'Укажите пространство и название папки' });
  if (parentId) {
    const parent = db.prepare('SELECT id FROM folders WHERE id = ? AND space_id = ?').get(parentId, spaceId);
    if (!parent) return res.status(400).json({ error: 'Родительская папка не найдена' });
  }
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM folders WHERE space_id = ? AND parent_id IS ?')
    .get(spaceId, parentId || null).m;
  const info = db
    .prepare('INSERT INTO folders (space_id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(spaceId, parentId || null, name.trim(), maxOrder + 1);
  res.status(201).json(toPublic(db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid)));
});

router.patch('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
  const { name, parentId } = req.body || {};

  if (parentId !== undefined && parentId !== folder.parent_id) {
    // защита от циклов: новый родитель не должен быть потомком текущей папки
    let cursor = parentId;
    while (cursor) {
      if (cursor === id) return res.status(400).json({ error: 'Нельзя переместить папку внутрь самой себя' });
      const p = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cursor);
      cursor = p ? p.parent_id : null;
    }
  }

  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : folder.name,
    parentId !== undefined ? parentId : folder.parent_id,
    id
  );
  res.json(toPublic(db.prepare('SELECT * FROM folders WHERE id = ?').get(id)));
});

router.delete('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
