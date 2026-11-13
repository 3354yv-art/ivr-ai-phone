import fs from 'fs';
import path from 'path';
import { cfg } from './config.js';

// מפתחות Groq שנתרמו על ידי אנשים אחרים. נשמרים בשרת בלבד (הרשאות 600), לעולם לא מוצגים במלואם
const file = () => path.join(cfg.dataDir, 'pool.json');
let pool = [];
try {
  pool = JSON.parse(fs.readFileSync(file(), 'utf8'));
} catch {
  /* אין מפתחות שנתרמו */
}
const save = () => {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(pool), { mode: 0o600 });
};

export const allKeys = () => [...cfg.groqKeys, ...pool.map((p) => p.key)];
export const poolList = () => pool.map((p) => ({ tail: p.key.slice(-4), t: p.t }));
export function removeByTail(tail) {
  pool = pool.filter((p) => p.key.slice(-4) !== tail);
  save();
}

async function valid(key) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>תרומת מפתח</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;display:flex;justify-content:center;padding:20px}.c{background:#fff;border-radius:12px;padding:24px;max-width:480px;box-shadow:0 2px 10px #0002}input[type=password]{width:100%;padding:10px;font-size:16px}button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:10px 20px;font-size:16px;cursor:pointer}</style></head><body><div class="c">${body}</div></body></html>`;

// דף התרומה פועל רק בחיבור מוצפן (https), כדי שהמפתח לא יעבור גלוי ברשת
const secure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

export function addPoolRoutes(app) {
  app.get('/donate', (req, res) => {
    if (!secure(req)) return res.status(403).send(page('<p>הדף הזה נפתח רק בכתובת מוצפנת (https).</p>'));
    res.send(page(`<h2>תרומת מפתח Groq לקו הטלפון</h2>
<p>המפתח נשמר בשרת בלבד, לא מוצג לאף אחד, והקו משתמש בו כדי לענות למתקשרים. אפשר לבקש את הסרתו בכל עת.</p>
<p><b>שימו לב:</b> השימוש במפתח נספר על החשבון שלכם ב-Groq, ובמסגרת החינמית שלו. תרמו רק מפתח משלכם, ובהסכמה.</p>
<form method="post" action="/donate"><p><input name="k" type="password" autocomplete="off" placeholder="gsk_..."></p>
<p><label><input type="checkbox" name="ok" value="1"> אני מבין ומסכים שהקו ישתמש במפתח שלי</label></p><button>שלח</button></form>`));
  });
  app.post('/donate', async (req, res) => {
    if (!secure(req)) return res.status(403).send(page('<p>רק בחיבור מוצפן.</p>'));
    const k = String(req.body?.k || '').trim();
    if (req.body?.ok !== '1') return res.status(400).send(page('<p>צריך לאשר את ההסכמה.</p>'));
    if (!/^gsk_[A-Za-z0-9]{20,100}$/.test(k)) return res.status(400).send(page('<p>המפתח לא נראה תקין.</p>'));
    if (allKeys().includes(k)) return res.send(page('<p>המפתח כבר קיים. תודה!</p>'));
    if (!(await valid(k))) return res.status(400).send(page('<p>המפתח לא עובד מול Groq.</p>'));
    pool.push({ key: k, t: Date.now() });
    save();
    res.send(page(`<p>תודה רבה! המפתח נקלט (מסתיים ב-${esc(k.slice(-4))}).</p>`));
  });
}
