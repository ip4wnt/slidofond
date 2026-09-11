# Развёртывание SlideVault на своём сервере

Сервис — обычное Node.js приложение (Express), которое само раздаёт фронтенд и API на одном порту (по умолчанию 8000). Nginx ставится перед ним как reverse-proxy (TLS, домен, кеш статики).

## 1. Требования на сервере

- Node.js 18+ и npm
- LibreOffice (headless) — для рендеринга слайдов в JPEG и сборки итоговых презентаций:
  ```bash
  sudo apt-get update && sudo apt-get install -y libreoffice
  ```
- Python 3 с пакетом `python-pptx` (используется вспомогательными скриптами анализа/сборки):
  ```bash
  sudo apt-get install -y python3 python3-pip
  pip3 install python-pptx
  ```
- nginx

## 2. Установка приложения

```bash
# скопируйте папку slidevault на сервер, например в /opt/slidevault
cd /opt/slidevault
npm install --production
```

Создайте файл `.env` (или экспортируйте переменные окружения перед запуском):

```
PORT=8000
SESSION_SECRET=замените-на-длинную-случайную-строку
```

`SESSION_SECRET` обязательно замените — это ключ подписи сессионных cookie.

## 3. Запуск как systemd-сервис

Создайте `/etc/systemd/system/slidevault.service`:

```ini
[Unit]
Description=SlideVault
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/slidevault
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
Environment=PORT=8000
Environment=SESSION_SECRET=замените-на-длинную-случайную-строку
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now slidevault
sudo systemctl status slidevault
```

## 4. Конфигурация nginx

Пример `/etc/nginx/sites-available/slidevault`:

```nginx
server {
    listen 80;
    server_name slidevault.example.com;

    client_max_body_size 200M;  # презентации могут быть большими

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cookie_path / "/; SameSite=Lax";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/slidevault /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Для HTTPS проще всего Certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d slidevault.example.com
```

После выпуска сертификата cookie сессии будут дополнительно иметь флаг `Secure` — в `server/index.js` при необходимости можно включить `cookie.secure = true`, когда сайт всегда доступен по HTTPS.

## 5. Первый вход

- Логин: `admin`
- Пароль: `admin`

Сразу после первого входа зайдите в панель пользователей (иконка в шапке) и смените пароль администратора, создайте нужных пользователей с ролями «Читатель» / «Редактор».

## 6. Данные и бэкапы

Все данные лежат в папке `storage/` (загруженные файлы, рендеры JPEG, база SQLite, временные сборки). Регулярно делайте резервную копию этой папки:

```bash
tar -czf slidevault-backup-$(date +%F).tar.gz storage/
```

## Почему в облачном превью Perplexity вход не работает

Предпросмотр через `deploy_website` открывает сайт в изолированном iframe на домене `sites.pplx.app` — там браузер по политике безопасности блокирует cookie, localStorage и sessionStorage для всех сайтов. Сессии на cookie в такой среде принципиально невозможны — это ограничение самой платформы предпросмотра, а не ошибка в коде. На вашем собственном сервере (см. выше) это ограничение отсутствует, и авторизация будет работать штатно.
