'use strict';

// Одноразовый скрипт: пересчитывает JPEG-превью для всех презентаций, у которых
// они не создались (например, из-за отсутствовавшего на сервере pdftoppm при первой загрузке).
// Запуск с папки проекта: node server/scripts/rerender_previews.js

const path = require('path');
const fs = require('fs');
const db = require('../db');
const { renderPreviews } = require('../services/renderer');
const { UPLOADS_DIR, PREVIEWS_DIR } = require('../utils/paths');

async function main() {
  const presentations = db.prepare('SELECT id, stored_filename, slide_count FROM presentations').all();
  console.log(`Найдено презентаций: ${presentations.length}`);

  for (const p of presentations) {
    const previewDir = path.join(PREVIEWS_DIR, String(p.id));
    // Проверяем не просто наличие хотя бы одного jpg, а полноту комплекта:
    // из-за бага со смешиванием старых/новых файлов в outDir могли остаться
    // превью с пропущенными индексами (например, есть slide-0 и slide-2, но нет slide-1).
    let hasCompletePreview = false;
    if (fs.existsSync(previewDir)) {
      const jpgIndexes = new Set(
        fs
          .readdirSync(previewDir)
          .filter((f) => /^slide-\d+\.jpg$/.test(f))
          .map((f) => parseInt(f.match(/(\d+)/)[1], 10))
      );
      const expected = p.slide_count || 0;
      hasCompletePreview =
        expected > 0 && jpgIndexes.size === expected && Array.from({ length: expected }, (_, i) => i).every((i) => jpgIndexes.has(i));
    }
    if (hasCompletePreview) {
      console.log(`#${p.id}: превью уже есть и полные, пропуск`);
      continue;
    }
    const filePath = path.join(UPLOADS_DIR, p.stored_filename);
    if (!fs.existsSync(filePath)) {
      console.log(`#${p.id}: исходный файл не найден (${filePath}), пропуск`);
      continue;
    }
    try {
      console.log(`#${p.id}: рендерю превью...`);
      await renderPreviews(p.id, filePath);
      console.log(`#${p.id}: готово`);
    } catch (err) {
      console.error(`#${p.id}: ошибка рендеринга — ${err.message}`);
    }
  }

  console.log('Завершено.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Скрипт завершился с ошибкой:', err);
  process.exit(1);
});
