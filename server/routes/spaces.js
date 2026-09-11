'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function toPublic(s) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    icon: s.icon,
    sortOrder: s.sort_order,
    isDefault: !!s.is_default,
  };
}

router.get('/', requireAuth, (req, res) => {
  const spaces = db.prepare('SELECT * FROM spaces ORDER BY sort_order, id').all();
  res.json(spaces.map(toPublic));
});

router.post('/', requireAuth, requireRole('editor'), (req, res) => {
  const { slug, name, icon } = req.body || {};
  if (!slug || !name) return res.status(400).json({ error: 'Укажите slug и название пространства' });
  const exists = db.prepare('SELECT id FROM spaces WHERE slug = ?').get(slug.trim());
  if (exists) return res.status(409).json({ error: 'Пространство с таким slug уже существует' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM spaces').get().m;
  const info = db
    .prepare('INSERT INTO spaces (slug, name, icon, sort_order) VALUES (?, ?, ?, ?)')
    .run(slug.trim(), name.trim(), icon || 'folder', maxOrder + 1);
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(toPublic(space));
});

router.patch('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
  if (!space) return res.status(404).json({ error: 'Пространство не найдено' });
  const { name, icon } = req.body || {};
  db.prepare('UPDATE spaces SET name = ?, icon = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : space.name,
    icon !== undefined ? icon : space.icon,
    id
  );
  res.json(toPublic(db.prepare('SELECT * FROM spaces WHERE id = ?').get(id)));
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
  if (!space) return res.status(404).json({ error: 'Пространство не найдено' });
  if (space.is_default) return res.status(400).json({ error: 'Нельзя удалить пространство по умолчанию' });
  db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
