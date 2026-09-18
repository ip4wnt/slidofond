'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PREVIEWS_DIR, TMP_DIR } = require('../utils/paths');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, timeout: 180000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} завершился с ошибкой: ${stderr || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

// Конвертирует презентацию в JPEG-превью для каждого слайда.
// Использует LibreOffice для получения PDF, затем pdftoppm для растеризации по страницам.
// Возвращает массив путей к jpeg-файлам (относительно PREVIEWS_DIR), по одному на слайд.
async function renderPreviews(presentationId, sourceFilePath) {
  const outDir = path.join(PREVIEWS_DIR, String(presentationId));

  // Рендерим во ВРЕМЕННУЮ директорию, а не прямо в outDir. Если рендер упадёт
  // посередине (LibreOffice/pdftoppm завершились с ошибкой) или его перезапустят,
  // старые готовые превью в outDir не должны смешаться с новыми/частичными
  // файлами — раньше именно это приводило к пропущенным/сдвинутым слайдам:
  // pdftoppm писал slide-1.jpg..slide-N.jpg прямо в outDir, где уже могли лежать
  // slide-0.jpg..slide-M.jpg от предыдущей попытки, и промежуточное состояние
  // могло быть прочитано или перезаписано непредсказуемо.
  const convertOutDir = path.join(TMP_DIR, `conv-${presentationId}-${Date.now()}`);
  const renderTmpDir = path.join(TMP_DIR, `render-${presentationId}-${Date.now()}`);
  fs.mkdirSync(convertOutDir, { recursive: true });
  fs.mkdirSync(renderTmpDir, { recursive: true });

  try {
    await run('soffice', [
      '--headless',
      '--norestore',
      '--convert-to',
      'pdf',
      '--outdir',
      convertOutDir,
      sourceFilePath,
    ]);

    const pdfFiles = fs.readdirSync(convertOutDir).filter((f) => f.endsWith('.pdf'));
    if (pdfFiles.length === 0) {
      throw new Error('LibreOffice не создал PDF-файл для рендеринга превью');
    }
    const pdfPath = path.join(convertOutDir, pdfFiles[0]);

    const prefix = path.join(renderTmpDir, 'slide');
    await run('pdftoppm', ['-jpeg', '-r', '110', pdfPath, prefix]);

    const jpegFiles = fs
      .readdirSync(renderTmpDir)
      .filter((f) => f.startsWith('slide') && f.endsWith('.jpg'))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)[1], 10);
        const nb = parseInt(b.match(/(\d+)/)[1], 10);
        return na - nb;
      });

    if (jpegFiles.length === 0) {
      throw new Error('pdftoppm не создал ни одного файла превью');
    }

    // Только теперь, когда рендер полностью успешен, очищаем старые превью (если были)
    // и атомарно переносим готовый комплект в outDir — pdftoppm нумерует страницы с 1,
    // переименовываем в 0-based и предсказуемый формат slide-N.jpg.
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const finalPaths = [];
    jpegFiles.forEach((f, idx) => {
      const finalName = `slide-${idx}.jpg`;
      fs.renameSync(path.join(renderTmpDir, f), path.join(outDir, finalName));
      finalPaths.push(finalName);
    });

    return finalPaths;
  } finally {
    fs.rmSync(convertOutDir, { recursive: true, force: true });
    fs.rmSync(renderTmpDir, { recursive: true, force: true });
  }
}

function previewPath(presentationId, slideIndex) {
  return path.join(PREVIEWS_DIR, String(presentationId), `slide-${slideIndex}.jpg`);
}

module.exports = { renderPreviews, previewPath };
