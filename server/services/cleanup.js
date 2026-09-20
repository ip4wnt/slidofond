'use strict';

const fs = require('fs');
const db = require('../db');

function cleanupExpiredExports() {
  const expired = db.prepare("SELECT * FROM export_jobs WHERE expires_at < datetime('now')").all();
  for (const job of expired) {
    if (job.file_path && fs.existsSync(job.file_path)) {
      fs.rmSync(job.file_path, { force: true });
    }
    db.prepare('DELETE FROM export_jobs WHERE id = ?').run(job.id);
  }
  if (expired.length > 0) {
    console.log(`[cleanup] Удалено просроченных сборок: ${expired.length}`);
  }
}

// Block 3: сгенерированные по промпту слайды (таблицы/графики) хранятся так же временно,
// как и обычные сборки из export_jobs — та же логика истечения срока.
function cleanupExpiredGenerations() {
  const expired = db.prepare("SELECT * FROM generation_jobs WHERE expires_at < datetime('now')").all();
  for (const job of expired) {
    if (job.file_path && fs.existsSync(job.file_path)) {
      fs.rmSync(job.file_path, { force: true });
    }
    db.prepare('DELETE FROM generation_jobs WHERE id = ?').run(job.id);
  }
  if (expired.length > 0) {
    console.log(`[cleanup] Удалено просроченных сгенерированных слайдов: ${expired.length}`);
  }
}

function startCleanupScheduler() {
  cleanupExpiredExports();
  cleanupExpiredGenerations();
  setInterval(() => {
    cleanupExpiredExports();
    cleanupExpiredGenerations();
  }, 30 * 60 * 1000); // каждые 30 минут
}

module.exports = { startCleanupScheduler, cleanupExpiredExports, cleanupExpiredGenerations };
