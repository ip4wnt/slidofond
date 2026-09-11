'use strict';

const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'pptx_extract.py');

// Запускает python-скрипт извлечения текста/метаданных из презентации.
// Возвращает Promise<{slide_count, slides, summary_text, file_created_at, file_modified_at}>
function analyzePresentation(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SCRIPT_PATH, filePath],
      { maxBuffer: 1024 * 1024 * 64, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Ошибка анализа презентации: ${stderr || err.message}`));
        }
        try {
          const data = JSON.parse(stdout);
          if (data.error) return reject(new Error(data.error));
          resolve(data);
        } catch (parseErr) {
          reject(new Error(`Не удалось разобрать результат анализа: ${parseErr.message}`));
        }
      }
    );
  });
}

module.exports = { analyzePresentation };
