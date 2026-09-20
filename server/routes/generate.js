'use strict';

// Block 3: генерация таблиц и графиков по промпту в стиле уже загруженных презентаций.
//
// Поток для пользователя (см. public/js/modules/generate.js для UI):
//   1. Загружает Excel-файл -> POST /api/generate/excel-preview -> получает разобранные
//      строки/колонки всех листов для выбора.
//   2. Выбирает содержимое (заголовки+строки для таблицы, либо колонку категорий+колонки
//      рядов для графика) и источник стиля:
//        - style.mode === 'donorUpload'  -> отдельно приложенный pptx-файл образца
//        - style.mode === 'donorTag'     -> styleSourceTagId уже существующего тега
//          (найденного через GET /api/generate/style-options)
//   3. POST /api/generate — собственно генерация; возвращает downloadUrl готового .pptx
//      либо, если данные не помещаются на слайд в читаемом виде, понятную ошибку с
//      конкретными максимумами (см. content_generate.py::compute_table_capacity).

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR, TMP_DIR } = require('../utils/paths');
const { parseExcelFile } = require('../services/excelParser');
const { generateSlide, GenerationError } = require('../services/contentGenerator');

const router = express.Router();
const EXPIRY_HOURS = 24;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Принимает опционально excelFile и donorFile в одном multipart-запросе — оба нужны в POST /api/generate,
// а excel-preview использует только excelFile.
const uploadFields = upload.fields([
  { name: 'excelFile', maxCount: 1 },
  { name: 'donorFile', maxCount: 1 },
]);

function cleanupTempFiles(files) {
  if (!files) return;
  for (const key of Object.keys(files)) {
    for (const f of files[key]) {
      fs.rmSync(f.path, { force: true });
    }
  }
}

// Разбирает загруженный Excel и отдаёт превью строк/колонок для выбора данных на фронтенде.
router.post('/excel-preview', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл Excel не приложен' });
  try {
    const data = await parseExcelFile(req.file.path);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});

// Список доступных образцов стиля (уже загруженных таблиц/графиков) в активном пространстве —
// для варианта "выбрать стиль из текущего пространства", когда пользователь не хочет
// приложить отдельный pptx-файл образца.
router.get('/style-options', requireAuth, (req, res) => {
  const contentType = req.query.contentType;
  const spaceId = req.query.spaceId ? Number(req.query.spaceId) : null;
  if (contentType !== 'table' && contentType !== 'chart') {
    return res.status(400).json({ error: 'contentType должен быть table или chart' });
  }
  const spaceFilter = spaceId ? 'AND p.space_id = ?' : '';
  const params = [contentType];
  if (spaceId) params.push(spaceId);

  const rows = db
    .prepare(
      `SELECT t.id AS tag_id, t.shape_index, t.source_kind, t.chart_type, t.label, t.confidence,
              s.id AS slide_id, s.slide_index,
              p.id AS presentation_id, p.original_filename
       FROM slide_content_tags t
       JOIN slides s ON s.id = t.slide_id
       JOIN presentations p ON p.id = s.presentation_id
       WHERE t.content_type = ? AND p.status = 'active' ${spaceFilter}
       ORDER BY t.confidence DESC, p.uploaded_at DESC
       LIMIT 50`
    )
    .all(...params);

  res.json({
    options: rows.map((r) => ({
      tagId: r.tag_id,
      presentationId: r.presentation_id,
      originalFilename: r.original_filename,
      slideIndex: r.slide_index,
      shapeIndex: r.shape_index,
      sourceKind: r.source_kind,
      chartType: r.chart_type,
      label: r.label,
    })),
  });
});

// Загружает style_payload + путь к файлу-донору + индексы слайда/фигуры по tagId (вариант "стиль из пространства").
function resolveStyleFromTag(tagId) {
  const row = db
    .prepare(
      `SELECT t.style_payload, t.shape_index,
              s.slide_index,
              p.stored_filename
       FROM slide_content_tags t
       JOIN slides s ON s.id = t.slide_id
       JOIN presentations p ON p.id = s.presentation_id
       WHERE t.id = ? AND p.status = 'active'`
    )
    .get(tagId);
  if (!row) return null;
  let stylePayload = {};
  try {
    stylePayload = JSON.parse(row.style_payload || '{}');
  } catch {
    stylePayload = {};
  }
  return {
    donorPath: path.join(UPLOADS_DIR, row.stored_filename),
    donorSlideIndex: row.slide_index,
    donorShapeIndex: row.shape_index,
    stylePayload,
  };
}

// Определяет фигуру-донор (первую таблицу/график нужного content_type) в только что
// приложенном пользователем pptx-файле образца, вызывая тот же анализатор, что и при
// обычной загрузке презентации (server/services/content_tags.py), но без сохранения в БД —
// файл используется одноразово только для чтения макета/стиля.
function resolveStyleFromUploadedDonor(donorPath, contentType) {
  const { execFileSync } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'services', 'inspect_donor.py');
  const configPath = path.join(TMP_DIR, `inspect-donor-${uuidv4()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ path: donorPath, contentType }), 'utf-8');
  try {
    const stdout = execFileSync('python3', [scriptPath, configPath], { maxBuffer: 1024 * 1024 * 32, timeout: 60000 });
    const data = JSON.parse(stdout.toString('utf-8'));
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

router.post('/', requireAuth, uploadFields, async (req, res) => {
  const files = req.files || {};
  try {
    let payload;
    try {
      payload = JSON.parse(req.body.payload || '{}');
    } catch {
      return res.status(400).json({ error: 'Некорректный формат payload' });
    }

    const { mode, style, table, chart, spaceId } = payload;
    if (mode !== 'table' && mode !== 'chart') {
      return res.status(400).json({ error: 'mode должен быть table или chart' });
    }
    if (!style || (style.mode !== 'donorTag' && style.mode !== 'donorUpload')) {
      return res.status(400).json({ error: 'Не указан источник стиля (style.mode)' });
    }

    let styleInfo;
    if (style.mode === 'donorTag') {
      styleInfo = resolveStyleFromTag(style.tagId);
      if (!styleInfo) {
        return res.status(404).json({ error: 'Выбранный образец стиля не найден — возможно, презентация была удалена' });
      }
    } else {
      const donorFile = files.donorFile && files.donorFile[0];
      if (!donorFile) {
        return res.status(400).json({ error: 'Приложите файл презентации-образца стиля' });
      }
      const donorData = resolveStyleFromUploadedDonor(donorFile.path, mode);
      if (!donorData.found) {
        return res.status(422).json({
          error: `В приложенной презентации-образце не найдено ни одной фигуры типа "${mode === 'table' ? 'таблица' : 'график'}" — выберите другой файл-образец.`,
        });
      }
      styleInfo = {
        donorPath: donorFile.path,
        donorSlideIndex: donorData.slideIndex,
        donorShapeIndex: donorData.shapeIndex,
        stylePayload: donorData.stylePayload,
      };
    }

    const genConfig = {
      mode,
      donorPath: styleInfo.donorPath,
      donorSlideIndex: styleInfo.donorSlideIndex,
      donorShapeIndex: styleInfo.donorShapeIndex,
      stylePayload: styleInfo.stylePayload,
    };
    if (mode === 'table') {
      if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
        return res.status(400).json({ error: 'Не переданы данные таблицы (headers/rows)' });
      }
      genConfig.table = table;
    } else {
      if (!chart || !Array.isArray(chart.categories) || !Array.isArray(chart.series)) {
        return res.status(400).json({ error: 'Не переданы данные графика (categories/series)' });
      }
      genConfig.chart = chart;
    }

    const outputPath = await generateSlide(genConfig);
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000).toISOString();
    const info = db
      .prepare(
        `INSERT INTO generation_jobs (requested_by, space_id, mode, style_source_tag_id, file_path, status, expires_at)
         VALUES (?, ?, ?, ?, ?, 'done', ?)`
      )
      .run(req.user.id, spaceId || null, mode, style.mode === 'donorTag' ? style.tagId : null, outputPath, expiresAt);

    res.status(201).json({
      id: info.lastInsertRowid,
      downloadUrl: `/api/generate/${info.lastInsertRowid}/download`,
      expiresAt,
    });
  } catch (err) {
    if (err instanceof GenerationError && err.code === 'TOO_LARGE') {
      return res.status(422).json({ error: err.message, errorCode: 'TOO_LARGE', ...err.details });
    }
    if (err instanceof GenerationError) {
      return res.status(500).json({ error: err.message, errorCode: err.code });
    }
    res.status(500).json({ error: err.message });
  } finally {
    // Загруженные исходники (Excel, приложенный donor pptx) — одноразовые входные файлы,
    // после генерации они не нужны (донор уже прочитан, а результат — отдельный сохранённый файл).
    cleanupTempFiles(files);
  }
});

router.get('/:id/download', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const job = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Сгенерированный файл не найден' });
  if (new Date(job.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Срок хранения файла истёк' });
  }
  if (!fs.existsSync(job.file_path)) return res.status(404).json({ error: 'Файл не найден на диске' });
  const filename = job.mode === 'table' ? 'сгенерированная-таблица.pptx' : 'сгенерированный-график.pptx';
  res.download(job.file_path, filename);
});

module.exports = router;
