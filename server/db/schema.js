'use strict';

// Создание всех таблиц базы данных. Идемпотентно — безопасно вызывать при каждом старте сервера.
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('reader','editor','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'folder',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS presentations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      slide_count INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_by_name TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_created_at TEXT,
      file_modified_at TEXT,
      summary_text TEXT NOT NULL DEFAULT '',
      summary_status TEXT NOT NULL DEFAULT 'pending' CHECK(summary_status IN ('pending','processing','done','error')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted'))
    );

    CREATE TABLE IF NOT EXISTS slides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      presentation_id INTEGER NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
      slide_index INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text_content TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      description_edited INTEGER NOT NULL DEFAULT 0,
      preview_jpeg_path TEXT
    );

    CREATE TABLE IF NOT EXISTS export_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by INTEGER REFERENCES users(id),
      query_text TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      slide_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','error')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_folders_space ON folders(space_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_presentations_folder ON presentations(folder_id);
    CREATE INDEX IF NOT EXISTS idx_presentations_space ON presentations(space_id);
    CREATE INDEX IF NOT EXISTS idx_slides_presentation ON slides(presentation_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS slides_fts USING fts5(
      title, text_content, description, content='slides', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS slides_ai AFTER INSERT ON slides BEGIN
      INSERT INTO slides_fts(rowid, title, text_content, description)
      VALUES (new.id, new.title, new.text_content, new.description);
    END;

    CREATE TRIGGER IF NOT EXISTS slides_ad AFTER DELETE ON slides BEGIN
      INSERT INTO slides_fts(slides_fts, rowid, title, text_content, description)
      VALUES ('delete', old.id, old.title, old.text_content, old.description);
    END;

    CREATE TRIGGER IF NOT EXISTS slides_au AFTER UPDATE ON slides BEGIN
      INSERT INTO slides_fts(slides_fts, rowid, title, text_content, description)
      VALUES ('delete', old.id, old.title, old.text_content, old.description);
      INSERT INTO slides_fts(rowid, title, text_content, description)
      VALUES (new.id, new.title, new.text_content, new.description);
    END;
  `);
}

module.exports = { ensureSchema };
