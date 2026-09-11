'use strict';

const db = require('../db');

const ROLE_RANK = { reader: 1, editor: 2, admin: 3 };

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Требуется вход в систему' });
  }
  const user = db.prepare('SELECT id, login, display_name, role FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
  req.user = user;
  next();
}

function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Требуется вход в систему' });
    }
    if (ROLE_RANK[req.user.role] < minRank) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, ROLE_RANK };
