'use strict';

const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.join(__dirname, '..', '..');
// Каталог данных (загрузки, превью, экспорт, база). В проде задается через SLIDEVAULT_DATA_DIR
// и указывает на отдельный диск для презентаций; по умолчанию — ./storage рядом с кодом.
const DATA_DIR = process.env.SLIDEVAULT_DATA_DIR ? path.resolve(process.env.SLIDEVAULT_DATA_DIR) : path.join(ROOT_DIR, 'storage');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, UPLOADS_DIR, PREVIEWS_DIR, EXPORTS_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { ROOT_DIR, DATA_DIR, UPLOADS_DIR, PREVIEWS_DIR, EXPORTS_DIR, TMP_DIR };
