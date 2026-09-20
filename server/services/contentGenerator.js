'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { EXPORTS_DIR, TMP_DIR } = require('../utils/paths');

const SCRIPT_PATH = path.join(__dirname, 'content_generate.py');

// config: { mode: 'table'|'chart', donorPath, donorSlideIndex, donorShapeIndex, stylePayload,
//           table?: {headers, rows}, chart?: {chartType?, categories, series} }
// Возвращает при успехе { outputPath }, при управляемой ошибке (данные не помещаются на слайд
// и т.п.) бросает GenerationError с полями code/details, которые роут превращает в HTTP-ответ
// с понятным пользователю объяснением.
class GenerationError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'GenerationError';
    this.code = code || 'INTERNAL';
    this.details = details || null;
  }
}

function generateSlide(config) {
  return new Promise((resolve, reject) => {
    const outputName = `generated-${uuidv4()}.pptx`;
    const outputPath = path.join(EXPORTS_DIR, outputName);
    const configPath = path.join(TMP_DIR, `generate-config-${uuidv4()}.json`);

    fs.writeFileSync(configPath, JSON.stringify({ ...config, output: outputPath }), 'utf-8');

    execFile(
      'python3',
      [SCRIPT_PATH, configPath],
      { maxBuffer: 1024 * 1024 * 64, timeout: 120000 },
      (err, stdout, stderr) => {
        fs.rmSync(configPath, { force: true });
        if (err) {
          return reject(new GenerationError(`Ошибка генерации слайда: ${stderr || err.message}`, 'PROCESS_FAILED'));
        }
        let data;
        try {
          data = JSON.parse(stdout);
        } catch (parseErr) {
          return reject(new GenerationError(`Не удалось разобрать результат генерации: ${parseErr.message}`, 'PARSE_FAILED'));
        }
        if (data.error) {
          return reject(new GenerationError(data.error, data.errorCode || 'INTERNAL', {
            capacity: data.capacity,
            requested: data.requested,
          }));
        }
        resolve(outputPath);
      }
    );
  });
}

module.exports = { generateSlide, GenerationError };
