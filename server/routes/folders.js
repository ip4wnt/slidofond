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
  const { name, parentId, sortOrder } = req.body || {};

  if (parentId !== undefined && parentId !== folder.parent_id) {
    // защита от циклов: новый родитель не должен быть потомком текущей папки
    let cursor = parentId;
    while (cursor) {
      if (cursor === id) return res.status(400).json({ error: 'Нельзя переместить папку внутрь самой себя' });
      const p = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cursor);
      cursor = p ? p.parent_id : null;
    }
    // при перемещении в другого родителя без явного sortOrder — ставим в конец нового списка сиблингов
    if (sortOrder === undefined) {
      const maxOrder = db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM folders WHERE space_id = ? AND parent_id IS ? AND id != ?')
        .get(folder.space_id, parentId || null, id).m;
      req.body.sortOrder = maxOrder + 1;
    }
  }

  db.prepare('UPDATE folders SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : folder.name,
    parentId !== undefined ? parentId : folder.parent_id,
    req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : sortOrder !== undefined ? Number(sortOrder) : folder.sort_order,
    id
  );
  res.json(toPublic(db.prepare('SELECT * FROM folders WHERE id = ?').get(id)));
});

// Переместить папку на одну позицию вверх/вниз среди сиблингов того же родителя (меняемся sort_order местами)
router.post('/:id/reorder', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const { direction } = req.body || {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction должен быть "up" или "down"' });
  }
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });

  const siblings = db
    .prepare('SELECT * FROM folders WHERE space_id = ? AND parent_id IS ? ORDER BY sort_order, name')
    .all(folder.space_id, folder.parent_id);
  const idx = siblings.findIndex((f) => f.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) {
    return res.json(siblings.map(toPublic)); // уже крайний элемент, ничего не меняем
  }

  const a = siblings[idx];
  const b = siblings[swapIdx];
  const tx = db.transaction(() => {
    db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(b.sort_order, a.id);
    db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(a.sort_order, b.id);
  });
  tx();

  const updated = db
    .prepare('SELECT * FROM folders WHERE space_id = ? AND parent_id IS ? ORDER BY sort_order, name')
    .all(folder.space_id, folder.parent_id);
  res.json(updated.map(toPublic));
});

// Отсортировать всех детей заданного родителя по алфавиту (asc/desc), перезаписывая sort_order
router.post('/sort', requireAuth, requireRole('editor'), (req, res) => {
  const { spaceId, parentId, order } = req.body || {};
  if (!spaceId) return res.status(400).json({ error: 'Укажите spaceId' });
  const dir = order === 'desc' ? 'desc' : 'asc';
  const siblings = db
    .prepare('SELECT * FROM folders WHERE space_id = ? AND parent_id IS ?')
    .all(spaceId, parentId || null);
  siblings.sort((a, b) => (dir === 'asc' ? a.name.localeCompare(b.name, 'ru') : b.name.localeCompare(a.name, 'ru')));

  const update = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => {
    siblings.forEach((f, i) => update.run(i, f.id));
  });
  tx();

  const updated = db
    .prepare('SELECT * FROM folders WHERE space_id = ? AND parent_id IS ? ORDER BY sort_order, name')
    .all(spaceId, parentId || null);
  res.json(updated.map(toPublic));
});

router.delete('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
