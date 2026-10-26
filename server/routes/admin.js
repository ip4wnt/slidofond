'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { autoFillAllUsageDates } = require('../services/yearResolver');

const router = express.Router();

// Пересборка производных метаданных для всех презентаций в базе (только администратор):
// автозаполнение «Когда» (год по папке, иначе по дате файла; ручные значения не трогаем)
// и полнотекстовые индексы. Нужна после изменений в правилах
// вычисления метаданных или массовой перекладки файлов по папкам.
router.post('/rebuild-metadata', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const years = autoFillAllUsageDates();
    db.exec("INSERT INTO presentations_fts(presentations_fts) VALUES ('rebuild')");
    const hasSlidesFts = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slides_fts'").get();
    if (hasSlidesFts) db.exec("INSERT INTO slides_fts(slides_fts) VALUES ('rebuild')");
    res.json({ ok: true, years, ftsRebuilt: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
