#!/usr/bin/env bash
# התקנה/עדכון של קו הטלפון בשרת Ubuntu. מריצים כ-root. בטוח להריץ שוב ושוב.
set -euo pipefail
APP=/opt/ivr-ai
REPO=https://github.com/3354yv-art/ivr-ai-phone
export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || apt-get install -y git

if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi
cd "$APP"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  KEY=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  cat > .env <<ENVEOF
IVR_KEY=$KEY
ALLOWED_PHONES=${ALLOWED_PHONES:-}
PORT=3000
DATA_DIR=$APP/data
ENV_FILE=$APP/.env
ENVEOF
fi
mkdir -p data
chown -R ubuntu:ubuntu "$APP"
chmod 600 .env

cp ivr-ai.service /etc/systemd/system/ivr-ai.service
systemctl daemon-reload
systemctl enable ivr-ai >/dev/null 2>&1
systemctl restart ivr-ai

# חומת האש המקומית של השרת (בנוסף צריך פורט פתוח ב-Security List באורקל)
iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 3000 -j ACCEPT
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true

sleep 2
echo "STATUS=$(systemctl is-active ivr-ai)"
echo "HEALTH=$(curl -s localhost:3000/health || echo fail)"
echo "IVR_KEY=$(grep '^IVR_KEY=' .env | cut -d= -f2)"
