import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';
import * as users from './users.js';

// ---------- יומן חיפושים וחסימות (נשמר בקבצים בשרת בלבד) ----------
const logFile = () => path.join(cfg.dataDir, 'queries.jsonl');
const blockFile = () => path.join(cfg.dataDir, 'blocked.json');
const norm = (p) => String(p || '').replace(/\D/g, '').slice(-9);

let blocked = new Set();
try {
  blocked = new Set(JSON.parse(fs.readFileSync(blockFile(), 'utf8')));
} catch {
  /* אין חסימות עדיין */
}
const saveBlocked = () => {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(blockFile(), JSON.stringify([...blocked]), { mode: 0o600 });
};

export const isBlocked = (phone) => !!norm(phone) && blocked.has(norm(phone));

// נרשם רק מה שהמתקשר אמר (חיפוש, שאלה, שם אתר). תוכן מייל לא נרשם לעולם
export function logQuery(phone, kind, text) {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify({ t: Date.now(), p: norm(phone) || 'חסוי', k: kind, q: t.slice(0, 300) }) + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn('רישום יומן נכשל', e.message);
  }
}

export function recentFor(phone, n = 3) {
  const k = norm(phone);
  return k ? readLog(500).filter((r) => r.p === k && r.k !== 'שיחה עם AI').slice(0, n) : [];
}

function readLog(limit = 200) {
  try {
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ---------- אימות: סיסמה מוצפנת (scrypt) בלבד, לעולם לא גלויה ----------
const user = () => (process.env.ADMIN_USER || 'יהונתן').normalize('NFC');
const hashEnv = () => process.env.ADMIN_HASH || '';

export function verifyPassword(name, password) {
  const [saltHex, hashHex] = hashEnv().split(':');
  if (!saltHex || !hashHex) return false;
  const given = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, 'hex');
  const okPass = want.length === given.length && crypto.timingSafeEqual(want, given);
  const a = Buffer.from(String(name).normalize('NFC'));
  const b = Buffer.from(user());
  const okName = a.length === b.length && crypto.timingSafeEqual(a, b);
  return okPass && okName;
}

const sessions = new Map();
let fails = [];
const cookieOf = (req, n) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${n}=([^;]+)`));
  return m ? m[1] : '';
};
const loggedIn = (req) => {
  const s = sessions.get(cookieOf(req, 'adm'));
  return !!s && s > Date.now();
};

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:16px}.card{background:#fff;border-radius:12px;padding:20px;max-width:900px;margin:0 auto 16px;box-shadow:0 2px 10px #0002}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:right}input{padding:8px;font-size:16px}
button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:15px;cursor:pointer}button.red{background:#c62828}h1,h2{margin-top:0}</style></head><body>${body}</body></html>`;

export function addAdminRoutes(app) {
  app.get('/admin', (req, res) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
    if (!hashEnv()) return res.status(503).send(shell('ניהול', '<div class="card"><p>סיסמת הניהול עדיין לא הוגדרה בשרת.</p></div>'));
    if (!loggedIn(req)) {
      const bad = req.query.e ? '<p style="color:#c62828">פרטים שגויים</p>' : '';
      return res.send(shell('כניסה', `<div class="card" style="max-width:360px"><h1>כניסה לניהול</h1>${bad}<form method="post" action="/admin/login"><p><input name="u" placeholder="שם משתמש" autocomplete="username" style="width:100%"></p><p><input name="p" type="password" placeholder="סיסמה" autocomplete="current-password" style="width:100%"></p><button>כניסה</button></form></div>`));
    }
    const log = readLog();
    const phones = Object.keys(JSON.parse(fs.existsSync(path.join(cfg.dataDir, 'users.json')) ? fs.readFileSync(path.join(cfg.dataDir, 'users.json'), 'utf8') : '{}'));
    const fmt = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const rows = log.map((r) => `<tr><td>${fmt(r.t)}</td><td dir="ltr">${esc(r.p)}</td><td>${esc(r.k)}</td><td>${esc(r.q)}</td><td>${r.p !== 'חסוי' ? `<form method="post" action="/admin/block"><input type="hidden" name="p" value="${esc(r.p)}"><button class="red">חסום</button></form>` : ''}</td></tr>`).join('');
    const bl = [...blocked].map((p) => `<tr><td dir="ltr">${esc(p)}</td><td><form method="post" action="/admin/unblock"><input type="hidden" name="p" value="${esc(p)}"><button>שחרר</button></form></td></tr>`).join('') || '<tr><td>אין חסומים</td></tr>';
    res.send(shell('ניהול', `<div class="card"><h1>ניהול קו הטלפון</h1><form method="post" action="/admin/logout"><button>יציאה</button></form></div>
<div class="card"><h2>חסימת מספר</h2><form method="post" action="/admin/block"><input name="p" placeholder="מספר טלפון" dir="ltr"> <button class="red">חסום</button></form><table>${bl}</table></div>
<div class="card"><h2>משתמשים מחוברים (${phones.length})</h2><p>מוצגים רק מספרים. תוכן המייל והחשבון שלהם לא נשמר ולא נראה כאן.</p><table>${phones.map((p) => `<tr><td dir="ltr">${esc(p)}</td></tr>`).join('')}</table></div>
<div class="card"><h2>מה חיפשו (200 אחרונים)</h2><table><tr><th>זמן</th><th>טלפון</th><th>סוג</th><th>נאמר</th><th></th></tr>${rows}</table></div>`));
  });

  app.post('/admin/login', (req, res) => {
    fails = fails.filter((t) => Date.now() - t < 15 * 60_000);
    if (fails.length >= 8) return res.status(429).send(shell('נחסם', '<div class="card"><p>יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.</p></div>'));
    if (!verifyPassword(req.body?.u || '', req.body?.p || '')) {
      fails.push(Date.now());
      return res.redirect('/admin?e=1');
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, Date.now() + 12 * 3600_000);
    res.set('set-cookie', `adm=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`);
    res.redirect('/admin');
  });
  const need = (req, res) => {
    if (loggedIn(req)) return true;
    res.status(403).send('אין גישה');
    return false;
  };
  app.post('/admin/logout', (req, res) => {
    sessions.delete(cookieOf(req, 'adm'));
    res.set('set-cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
    res.redirect('/admin');
  });
  app.post('/admin/block', (req, res) => {
    if (!need(req, res)) return;
    const p = norm(req.body?.p);
    if (p.length >= 9) {
      blocked.add(p);
      saveBlocked();
    }
    res.redirect('/admin');
  });
  app.post('/admin/unblock', (req, res) => {
    if (!need(req, res)) return;
    blocked.delete(norm(req.body?.p));
    saveBlocked();
    res.redirect('/admin');
  });
}
