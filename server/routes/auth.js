'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, login: user.login, displayName: user.display_name, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    login: req.user.login,
    displayName: req.user.display_name,
    role: req.user.role,
  });
});

module.exports = router;
