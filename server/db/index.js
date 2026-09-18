'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { ensureSchema } = require('./schema');
const { DATA_DIR } = require('../utils/paths');

const DB_PATH = path.join(DATA_DIR, 'slidevault.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

ensureSchema(db);
seedDefaults();

function seedDefaults() {
  const spaceCount = db.prepare('SELECT COUNT(*) AS c FROM spaces').get().c;
  if (spaceCount === 0) {
    const insertSpace = db.prepare(
      'INSERT INTO spaces (slug, name, icon, sort_order, is_default) VALUES (?, ?, ?, ?, ?)'
    );
    const fpg = insertSpace.run('fpg', 'ФПГ', 'landmark', 0, 1);
    insertSpace.run('education', 'Просвещение', 'book', 1, 0);
    insertSpace.run('media', 'Медиа и коммуникации', 'megaphone', 2, 0);

    // Для ФПГ создаём папки по годам 2017–2026
    const insertFolder = db.prepare(
      'INSERT INTO folders (space_id, parent_id, name, sort_order) VALUES (?, NULL, ?, ?)'
    );
    let order = 0;
    for (let year = 2017; year <= 2026; year++) {
      insertFolder.run(fpg.lastInsertRowid, String(year), order++);
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare(
      'INSERT INTO users (login, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
    ).run('admin', hash, 'Илья Панкратов', 'admin');
  } else {
    // На уже развёрнутых базах меняем старое отображаемое имя администратора на актуальное.
    db.prepare(
      "UPDATE users SET display_name = 'Илья Панкратов' WHERE login = 'admin' AND display_name = 'Администратор'"
    ).run();
  }
}

module.exports = db;
