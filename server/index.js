'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');

const { startCleanupScheduler } = require('./services/cleanup');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const spaceRoutes = require('./routes/spaces');
const folderRoutes = require('./routes/folders');
const presentationRoutes = require('./routes/presentations');
const slideRoutes = require('./routes/slides');
const searchRoutes = require('./routes/search');
const buildRoutes = require('./routes/build');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'slidevault-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 3600 * 1000, // 7 дней
      sameSite: 'lax',
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/spaces', spaceRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/presentations', presentationRoutes);
app.use('/api/slides', slideRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/build', buildRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'Не найдено' });
});

// Централизованный обработчик ошибок (включая ошибки multer)
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(400).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

startCleanupScheduler();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SlideVault сервер запущен на порту ${PORT}`);
});
