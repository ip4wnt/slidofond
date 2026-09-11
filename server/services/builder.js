'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { EXPORTS_DIR, TMP_DIR } = require('../utils/paths');

const SCRIPT_PATH = path.join(__dirname, 'pptx_build.py');

// items: [{ path: '/abs/path/source.pptx', index: 0 }, ...]
// Возвращает абсолютный путь к собранному pptx-файлу в EXPORTS_DIR.
function buildPresentation(items) {
  return new Promise((resolve, reject) => {
    if (!items || items.length === 0) {
      return reject(new Error('Не переданы слайды для сборки'));
    }
    const outputName = `build-${uuidv4()}.pptx`;
    const outputPath = path.join(EXPORTS_DIR, outputName);
    const configPath = path.join(TMP_DIR, `build-config-${uuidv4()}.json`);

    fs.writeFileSync(configPath, JSON.stringify({ items, output: outputPath }), 'utf-8');

    execFile(
      'python3',
      [SCRIPT_PATH, configPath],
      { maxBuffer: 1024 * 1024 * 64, timeout: 180000 },
      (err, stdout, stderr) => {
        fs.rmSync(configPath, { force: true });
        if (err) {
          return reject(new Error(`Ошибка сборки презентации: ${stderr || err.message}`));
        }
        try {
          const data = JSON.parse(stdout);
          if (data.error) return reject(new Error(data.error));
          resolve(outputPath);
        } catch (parseErr) {
          reject(new Error(`Не удалось разобрать результат сборки: ${parseErr.message}`));
        }
      }
    );
  });
}

module.exports = { buildPresentation };
