# SlideVault — архитектура

## Стек
- Backend: Node.js (без TypeScript) + Express + better-sqlite3 (SQLite) + bcrypt + express-session + multer
- Рендеринг слайдов: LibreOffice headless (soffice --convert-to pdf) + pdftoppm (poppler-utils) → JPEG
- Сборка итоговой презентации: python-pptx (копирование слайдов один-в-один без потери форматирования) — вызывается как child_process из Node
- Frontend: чистый JS (ES-модули), без фреймворков, собственный state/render слой
- Веб-сервер раздачи в проде: nginx перед Node (в песочнице — просто Node на порту, деплой через прокси)

## Роли пользователей
- `reader` — поиск, просмотр хранилища, копирование слайдов, сборка presentаций
- `editor` — то же + загрузка файлов, редактирование описаний (любых презентаций), удаление ТОЛЬКО своих презентаций, CRUD папок
- `admin` — всё, включая удаление чужих презентаций и управление пользователями (создание/роли/пароли)

## Модель данных (SQLite)

### users
- id, login (unique), password_hash, display_name, role (reader|editor|admin), created_at

### spaces (пространства направлений деятельности)
- id, slug (unique, напр. "fpg"), name, icon (emoji/svg-key), sort_order, is_default

### folders (иерархия папок внутри пространства)
- id, space_id, parent_id (nullable), name, sort_order, created_at

### presentations
- id, folder_id, space_id, original_filename, stored_filename (на диске), file_ext (pptx/ppt/pdf/odp),
  file_size_bytes, slide_count, uploaded_by (user_id), uploaded_by_name, uploaded_at,
  file_created_at (из меты файла), file_modified_at (из меты файла),
  summary_text (описание всей презентации), summary_status (pending/processing/done/error),
  status (active/deleted)

### slides
- id, presentation_id, slide_index (0-based), title (эвристически извлечённый), text_content (весь извлечённый текст),
  description (сгенерированное описание), description_edited (bool — редактировали вручную), preview_jpeg_path

### search_index (FTS5 virtual table) — по slides(description, text_content, title) и presentations(summary_text, original_filename)

### export_jobs (временные сборки презентаций по запросу)
- id, requested_by, query_text, file_path, created_at, expires_at, status

### sessions — управляется express-session (можно хранить в памяти/файле для прототипа уровня "полноценно" — используем connect-sqlite3-подобное простое хранилище на файле)

## Backend модули (server/)
- index.js — точка входа, поднимает express, сессии, роуты, статику
- db/schema.js — создание таблиц + миграции при старте
- db/index.js — подключение к better-sqlite3
- middleware/auth.js — requireAuth, requireRole(role)
- routes/auth.js — POST /api/login, POST /api/logout, GET /api/me
- routes/users.js — CRUD пользователей (admin only)
- routes/spaces.js — CRUD пространств
- routes/folders.js — CRUD папок (дерево)
- routes/presentations.js — upload, list, get, delete, update description, download, slide preview list
- routes/slides.js — PATCH описания слайда
- routes/search.js — GET /api/search?q=&spaces=
- routes/build.js — POST /api/build (сборка презентации по списку slide_id), GET /api/build/:id/download
- services/fileMeta.js — извлечение дат создания/изменения из файла (fs.stat + метаданные pptx core.xml)
- services/pptxAnalyzer.js — извлечение текста по слайдам (python-pptx через child_process скрипт) + эвристическое описание
- services/renderer.js — конвертация pptx->pdf->jpeg по слайдам (soffice + pdftoppm), кэш в storage/previews/<presentation_id>/slide-N.jpg
- services/builder.js — сборка новой pptx из выбранных (presentation_id, slide_index) через python-pptx скрипт
- services/cleanup.js — периodическая (setInterval) очистка export_jobs старше 24ч
- utils/paths.js — общие пути на диске

## Frontend структура (public/)
- index.html — SPA-шелл (одна страница, состояния переключаются JS)
- css/styles.css — дизайн-система (переменные, компоненты)
- js/app.js — точка входа, инициализация роутов состояний (home / search-results / build-result / storage)
- js/state/store.js — простой pub-sub стор (createStore), единственный источник состояния
- js/modules/api.js — обёртка над fetch к /api/*
- js/modules/home.js — рендер главной страницы (поиск + переключатель пространств)
- js/modules/searchResults.js — рендер результатов поиска слайдов / результата сборки
- js/modules/storage.js — рендер хранилища (дерево папок + список файлов)
- js/modules/folderTree.js — компонент дерева папок (рекурсивный рендер, CRUD контекстное меню)
- js/modules/fileList.js — список презентаций с метаданными, разворачивание описаний
- js/modules/slideGallery.js — модалка-галерея превью слайдов
- js/modules/upload.js — drag&drop + кнопка загрузки
- js/modules/render.js — минимальный helper h()/render() для декларативного DOM без фреймворка
- js/modules/toast.js — уведомления

## Ключевые сценарии
1. Загрузка: POST /api/presentations (multipart) -> сохраняем оригинал как есть -> создаём запись presentation (status=processing) -> асинхронно: рендерим слайды в JPEG, извлекаем текст, генерируем описания -> обновляем summary_status=done
2. Поиск слайда: GET /api/search?q=...&spaces=fpg,marketing -> FTS5 по slides+presentations в рамках выбранных spaces -> список карточек с превью
3. Копирование слайда: клиент запрашивает сам JPEG предпросмотра и/или отдельный pptx с одним слайдом (POST /api/build с одним slide) для вставки через "Вставить слайды из файла" в PowerPoint — при клике "скопировать" скачиваем one-slide pptx
4. Сборка презентации: POST /api/build {slide_ids:[...]} -> builder.js собирает pptx из исходников python-pptx -> сохраняет в storage/exports -> запись в export_jobs с expires_at = +24h -> отдаём download-ссылку
5. Очистка: cleanup.js каждые 30 минут удаляет файлы и записи с expires_at < now

## Права на удаление/редактирование
- DELETE /api/presentations/:id — allow if user.role==='admin' OR (user.role==='editor' AND presentation.uploaded_by===user.id)
- PATCH /api/presentations/:id/summary, PATCH /api/slides/:id — allow if role in (editor, admin)
- Папки/пространства CRUD — allow if role in (editor, admin)
- Загрузка — allow if role in (editor, admin)
- Поиск/просмотр/сборка/скачивание — allow for all authenticated (reader+)
