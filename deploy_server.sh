#!/usr/bin/env bash
# Первый деплой SlideVault на сервере 51.250.103.117 (пользователь pankratov)
# Запускать НА СЕРВЕРЕ (через ssh pankratov@51.250.103.117), не в песочнице.
set -euo pipefail

REPO_URL="https://github.com/ip4wnt/slidofond.git"
APP_DIR="/home/pankratov/slidevault"
PORT="8000"

echo "== 1. Системные зависимости =="
sudo apt-get update
sudo apt-get install -y nodejs npm libreoffice python3 python3-pip nginx git
pip3 install --user python-pptx

echo "== 2. Клонирование репозитория =="
if [ -d "$APP_DIR/.git" ]; then
  echo "Репозиторий уже существует, обновляю..."
  cd "$APP_DIR"
  git pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "== 3. Установка npm-зависимостей =="
npm install --production

echo "== 4. Файл окружения =="
if [ ! -f "$APP_DIR/.env" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
SESSION_SECRET=$SECRET
EOF
  echo "Создан .env со случайным SESSION_SECRET"
else
  echo ".env уже существует, не трогаю"
fi

echo "== 5. systemd-сервис =="
sudo tee /etc/systemd/system/slidevault.service > /dev/null <<EOF
[Unit]
Description=SlideVault
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
User=pankratov

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now slidevault
sudo systemctl status slidevault --no-pager

echo "== 6. nginx =="
read -rp "Введите домен для сайта (или Enter, чтобы пропустить и настроить nginx вручную): " DOMAIN
if [ -n "${DOMAIN:-}" ]; then
  sudo tee /etc/nginx/sites-available/slidevault > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cookie_path / "/; SameSite=Lax";
    }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/slidevault /etc/nginx/sites-enabled/slidevault
  sudo nginx -t && sudo systemctl reload nginx
  echo "nginx настроен для $DOMAIN. Для HTTPS выполните:"
  echo "  sudo apt-get install -y certbot python3-certbot-nginx"
  echo "  sudo certbot --nginx -d $DOMAIN"
else
  echo "nginx пропущен — настройте вручную по образцу в DEPLOY.md"
fi

echo ""
echo "Готово. Проверьте: http://51.250.103.117:$PORT (или через домен/nginx)."
echo "Первый вход: admin / admin — сразу смените пароль."
