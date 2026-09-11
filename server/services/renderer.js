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
  fs.mkdirSync(outDir, { recursive: true });

  const convertOutDir = path.join(TMP_DIR, `conv-${presentationId}-${Date.now()}`);
  fs.mkdirSync(convertOutDir, { recursive: true });

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

    const prefix = path.join(outDir, 'slide');
    await run('pdftoppm', ['-jpeg', '-r', '110', pdfPath, prefix]);

    const jpegFiles = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith('slide') && f.endsWith('.jpg'))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)[1], 10);
        const nb = parseInt(b.match(/(\d+)/)[1], 10);
        return na - nb;
      });

    // pdftoppm нумерует файлы с 1 — переименуем в 0-based и предсказуемый формат slide-N.jpg
    const finalPaths = [];
    jpegFiles.forEach((f, idx) => {
      const finalName = `slide-${idx}.jpg`;
      const finalPath = path.join(outDir, finalName);
      fs.renameSync(path.join(outDir, f), finalPath);
      finalPaths.push(finalName);
    });

    return finalPaths;
  } finally {
    fs.rmSync(convertOutDir, { recursive: true, force: true });
  }
}

function previewPath(presentationId, slideIndex) {
  return path.join(PREVIEWS_DIR, String(presentationId), `slide-${slideIndex}.jpg`);
}

module.exports = { renderPreviews, previewPath };
