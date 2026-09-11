'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Редактирование описания отдельного слайда — editor/admin (любого слайда)
router.patch('/:id', requireAuth, requireRole('editor'), (req, res) => {
  const id = Number(req.params.id);
  const slide = db.prepare('SELECT * FROM slides WHERE id = ?').get(id);
  if (!slide) return res.status(404).json({ error: 'Слайд не найден' });
  const { description, title } = req.body || {};
  db.prepare('UPDATE slides SET description = ?, title = ?, description_edited = 1 WHERE id = ?').run(
    description !== undefined ? description : slide.description,
    title !== undefined ? title : slide.title,
    id
  );
  const updated = db.prepare('SELECT * FROM slides WHERE id = ?').get(id);
  res.json({
    id: updated.id,
    presentationId: updated.presentation_id,
    index: updated.slide_index,
    title: updated.title,
    description: updated.description,
    descriptionEdited: !!updated.description_edited,
  });
});

module.exports = router;
