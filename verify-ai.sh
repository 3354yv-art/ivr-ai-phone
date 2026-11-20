#!/bin/bash
# בדיקה על השרת: שאלות ידע וחיפוש, עם המפתחות של השרת
export PATH="$HOME/node/bin:$PATH"; cd ~/ivr-ai; set -a; . ./.env 2>/dev/null; set +a; export DATA_DIR="$(mktemp -d)"
cat > /tmp/v.mjs <<'JS'
const ai = await import(process.cwd() + '/src/ai.js');
for (const q of ['מי זה אברהם פריד?', 'תחפש מתמחים טופ', 'מה מזג האוויר היום בירושלים?']) {
  const t = Date.now();
  const r = await ai.chat([], q, '', true);
  let out = JSON.stringify(r);
  if (r.action === 'search') out += ' => ' + (await ai.search(r.query || q)).answer;
  console.log('VA', Date.now() - t, 'ms |', q, '|', out.replace(/\s+/g, ' ').slice(0, 260));
}
process.exit(0);
JS
timeout 90 node /tmp/v.mjs 2>&1 | grep '^VA'; rm -rf "$DATA_DIR"
