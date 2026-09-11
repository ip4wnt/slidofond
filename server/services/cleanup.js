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

function startCleanupScheduler() {
  cleanupExpiredExports();
  setInterval(cleanupExpiredExports, 30 * 60 * 1000); // каждые 30 минут
}

module.exports = { startCleanupScheduler, cleanupExpiredExports };
