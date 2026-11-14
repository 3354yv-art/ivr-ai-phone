#!/bin/bash
# בדיקת מהירות ואיכות על השרת עצמו (עם המפתחות שבשרת). לא מדפיס מפתחות.
export PATH="$HOME/node/bin:$PATH"
cd ~/ivr-ai
set -a; . ./.env 2>/dev/null; set +a
export DATA_DIR="$(mktemp -d)"
cat > /tmp/perf.mjs <<'JS'
const ai = await import(process.cwd() + '/src/ai.js');
const { wiki, ddg } = await import(process.cwd() + '/src/local.js');
const { webAnswer, keyStats } = await import(process.cwd() + '/src/llm.js');
const time = async (name, p) => { const t = Date.now(); try { const v = await p; console.log(`PT ${name}: ${Date.now() - t}ms |`, String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 110)); } catch (e) { console.log(`PT ${name}: FAIL ${Date.now() - t}ms`, String(e.message).slice(0, 120)); } };
await time('wiki', wiki('ירושלים').then((r) => r.length + ' ' + (r[0]?.title || '')));
await time('ddg', ddg('מזג אוויר ירושלים').then((r) => r.length));
await time('chat', ai.chat([], 'מה בירת צרפת?'));
await time('chat2', ai.chat([], 'תן לי רעיון לארוחת ערב'));
await time('search', ai.search('מי בנה את בית המקדש הראשון').then((r) => r.answer));
await time('search-cache', ai.search('מי בנה את בית המקדש הראשון').then((r) => r.answer));
for (let i = 0; i < 3; i++) await time('webAnswer', webAnswer('מה מזג האוויר היום בירושלים'));
await time('parallel5', Promise.all([1, 2, 3, 4, 5].map((i) => ai.chat([], `כמה זה ${i} ועוד ${i}?`))));
console.log('PT keys', JSON.stringify(keyStats().map((k) => [k.tail.slice(-2), k.ok, k.fail, k.ms])));
process.exit(0);
JS
timeout 120 node /tmp/perf.mjs 2>&1 | grep -E "^PT"
rm -rf "$DATA_DIR"
