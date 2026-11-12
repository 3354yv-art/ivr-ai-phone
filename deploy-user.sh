#!/usr/bin/env bash
# התקנה/עדכון בלי הרשאות מנהל (למשתמש רגיל). בטוח להריץ שוב ושוב.
set -uo pipefail
H="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
APP="$H/ivr-ai"; BIN="$H/bin"; NODEV=v22.11.0
mkdir -p "$APP" "$BIN"
cd "$H"

if [ ! -x "$H/node/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODEV/node-$NODEV-linux-arm64.tar.xz" -o node.tar.xz || { echo "FAIL node download"; exit 1; }
  mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1 && rm -f node.tar.xz
fi
export PATH="$H/node/bin:$BIN:$PATH"

curl -fsSL https://github.com/3354yv-art/ivr-ai-phone/archive/refs/heads/main.tar.gz -o src.tgz || { echo "FAIL repo download"; exit 1; }
tar -xzf src.tgz -C "$APP" --strip-components=1 && rm -f src.tgz
cd "$APP"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || { echo "FAIL npm install"; exit 1; }

if [ ! -f .env ]; then
  KEY=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  cat > .env <<ENVEOF
IVR_KEY=$KEY
ALLOWED_PHONES=0556791058
PORT=3000
DATA_DIR=$APP/data
ENV_FILE=$APP/.env
ENVEOF
fi
mkdir -p data; chmod 600 .env

if [ ! -x "$BIN/cloudflared" ]; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o "$BIN/cloudflared" || { echo "FAIL cloudflared download"; exit 1; }
  chmod +x "$BIN/cloudflared"
fi

cat > "$APP/run-server.sh" <<'RS'
#!/usr/bin/env bash
H="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$H/node/bin:$PATH"
cd "$H/ivr-ai"
while true; do
  set -a; . ./.env; set +a
  [ -f tunnel-url.txt ] && export BASE_URL="$(cat tunnel-url.txt)"
  node src/server.js >> server.log 2>&1
  sleep 2
done
RS
cat > "$APP/run-tunnel.sh" <<'RT'
#!/usr/bin/env bash
H="$(cd "$(dirname "$0")/.." && pwd)"
cd "$H/ivr-ai"
while true; do
  "$H/bin/cloudflared" tunnel --no-autoupdate --url http://localhost:3000 >> tunnel.log 2>&1
  sleep 5
done
RT
cat > "$APP/start.sh" <<'ST'
#!/usr/bin/env bash
H="$(cd "$(dirname "$0")/.." && pwd)"
cd "$H/ivr-ai"
pkill -f run-server.sh; pkill -f run-tunnel.sh; pkill -f "node src/server.js"; pkill -f "cloudflared tunnel"
sleep 1
: > tunnel.log; rm -f tunnel-url.txt
setsid nohup ./run-tunnel.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 30); do
  U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1)
  [ -n "$U" ] && { echo "$U" > tunnel-url.txt; break; }
  sleep 2
done
setsid nohup ./run-server.sh >/dev/null 2>&1 < /dev/null &
ST
chmod +x run-server.sh run-tunnel.sh start.sh
./start.sh

( crontab -l 2>/dev/null | grep -v 'ivr-ai/start.sh'; echo "@reboot $APP/start.sh" ) | crontab - 2>/dev/null || true

sleep 4
echo "HEALTH=$(curl -s localhost:3000/health || echo fail)"
echo "URL=$(cat tunnel-url.txt 2>/dev/null || echo none)"
echo "IVR_KEY=$(grep '^IVR_KEY=' .env | cut -d= -f2)"
