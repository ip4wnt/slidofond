#!/usr/bin/env bash
# Обновление уже развёрнутого SlideVault на сервере — запускать НА СЕРВЕРЕ
# после каждого нового push в GitHub main.
set -euo pipefail

APP_DIR="/home/pankratov/slidevault"

cd "$APP_DIR"
echo "== Подтягиваю изменения из GitHub =="
git pull origin main

echo "== Обновляю npm-зависимости (если менялись) =="
npm install --production

echo "== Перезапускаю сервис =="
sudo systemctl restart slidevault
sudo systemctl status slidevault --no-pager

echo "Обновление завершено."
