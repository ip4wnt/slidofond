'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function toPublic(u) {
  return { id: u.id, login: u.login, displayName: u.display_name, role: u.role, createdAt: u.created_at };
}

// Список пользователей — только админ
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json(users.map(toPublic));
});

// Создание пользователя — только админ
router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { login, password, displayName, role } = req.body || {};
  if (!login || !password || !displayName || !role) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!['reader', 'editor', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE login = ?').get(login.trim());
  if (exists) {
    return res.status(409).json({ error: 'Такой логин уже существует' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (login, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
    .run(login.trim(), hash, displayName.trim(), role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(toPublic(user));
});

// Изменение роли/имени/пароля — только админ
router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const { displayName, role, password } = req.body || {};
  if (role && !['reader', 'editor', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }
  if (role === 'reader' && user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Нельзя понизить последнего администратора' });
    }
  }
  const newDisplayName = displayName !== undefined ? displayName.trim() : user.display_name;
  const newRole = role || user.role;
  const newHash = password ? bcrypt.hashSync(password, 10) : user.password_hash;

  db.prepare('UPDATE users SET display_name = ?, role = ?, password_hash = ? WHERE id = ?').run(
    newDisplayName,
    newRole,
    newHash,
    id
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json(toPublic(updated));
});

// Удаление пользователя — только админ, нельзя удалить себя или последнего админа
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
