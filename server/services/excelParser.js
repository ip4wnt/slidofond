'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { TMP_DIR } = require('../utils/paths');

const SCRIPT_PATH = path.join(__dirname, 'excel_parse.py');

// Читает Excel-файл (.xlsx/.xls) и возвращает { sheets: [{ name, rows, rowCount, colCount, truncated }] }
// для превью в UI перед генерацией таблицы/графика (Block 3). Выбор конкретных строк/колонок
// делает пользователь на фронтенде — здесь только парсинг сырых данных.
function parseExcelFile(excelPath) {
  return new Promise((resolve, reject) => {
    const configPath = path.join(TMP_DIR, `excel-parse-${uuidv4()}.json`);
    fs.writeFileSync(configPath, JSON.stringify({ path: excelPath }), 'utf-8');

    execFile(
      'python3',
      [SCRIPT_PATH, configPath],
      { maxBuffer: 1024 * 1024 * 32, timeout: 60000 },
      (err, stdout, stderr) => {
        fs.rmSync(configPath, { force: true });
        if (err) {
          return reject(new Error(`Ошибка чтения Excel-файла: ${stderr || err.message}`));
        }
        try {
          const data = JSON.parse(stdout);
          if (data.error) return reject(new Error(data.error));
          resolve(data);
        } catch (parseErr) {
          reject(new Error(`Не удалось разобрать результат чтения Excel: ${parseErr.message}`));
        }
      }
    );
  });
}

module.exports = { parseExcelFile };
