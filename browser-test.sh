#!/bin/bash
# בדיקת התאמה: האם אפשר להריץ דפדפן אמיתי (Chromium) בשרת, ומה גוגל עושה מולו
set -u
export PATH="$HOME/node/bin:$PATH"
mkdir -p ~/bt && cd ~/bt
[ -f package.json ] || npm init -y >/dev/null 2>&1
npm i playwright >/dev/null 2>&1 || { echo "BT npm-fail"; exit 0; }
timeout 280 npx playwright install chromium >/tmp/bt-install.log 2>&1 || { echo "BT install-fail: $(tail -n 2 /tmp/bt-install.log | tr '\n' ' ')"; exit 0; }
cat > t.mjs <<'JS'
import { chromium } from 'playwright';
try {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('https://www.google.com/search?q=test', { timeout: 30000 });
  console.log('BT title:', (await p.title()).slice(0, 60), '| url:', p.url().slice(0, 60));
  await p.goto('https://accounts.google.com/', { timeout: 30000 });
  console.log('BT login-page:', (await p.title()).slice(0, 60));
  await b.close();
} catch (e) { console.log('BT run-fail:', String(e.message).split('\n')[0].slice(0, 200)); }
JS
node t.mjs
