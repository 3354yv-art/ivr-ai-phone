#!/bin/bash
# עדכון מלא בשרת: קוד, חבילות (כולל דפדפן לעוזר), הפעלה מחדש ובדיקה. רץ כמשתמש הרגיל, בלי sudo.
export PATH="$HOME/node/bin:$PATH"
REF="${1:-main}"
cd ~/ivr-ai || exit 1
curl -fsSL "https://codeload.github.com/3354yv-art/ivr-ai-phone/tar.gz/$REF" | tar xz --strip-components=1 -C ~/ivr-ai || { echo "UP code-fail"; exit 1; }
npm i --omit=dev --no-audit --no-fund >/tmp/npm.log 2>&1 && echo "UP npm=ok" || echo "UP npm=fail $(tail -n 2 /tmp/npm.log | tr '\n' ' ')"
timeout 400 npx playwright install chromium >/tmp/pw.log 2>&1 && echo "UP chromium=ok" || echo "UP chromium=fail $(tail -n 2 /tmp/pw.log | tr '\n' ' ')"
(pkill -f 'node [s]rc/server.js' || true)
sleep 12
echo "UP HEALTH=$(curl -s localhost:3000/health) MY=$(curl -s -o /dev/null -w %{http_code} localhost:6080/my)"
cat > /tmp/bt.mjs <<'JS'
const b = await import(process.cwd() + '/src/browser.js');
try {
  console.log('UP browser-available', await b.available());
  const t = Date.now();
  const p = await b.open('t', 'https://mitmachim.top');
  console.log('UP open', Date.now() - t, 'ms', p.title.slice(0, 40), 'els', p.els.length);
  const f = p.els.find((e) => e.kind === 'שדה');
  console.log('UP first-field', f ? f.text : 'none');
  await b.close('t');
} catch (e) { console.log('UP browser-fail', String(e.message).slice(0, 200)); }
process.exit(0);
JS
timeout 60 node /tmp/bt.mjs 2>&1 | grep '^UP'
