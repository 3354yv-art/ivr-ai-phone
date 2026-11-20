import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';
import * as users from './users.js';
import { poolList, removeByTail } from './pool.js';
import { listRules, addRule, removeRule, getSetting, setSetting } from './rules.js';
import { adminChat } from './ai.js';
import { keyStats } from './llm.js';
import { Forum, FORUMS, dropForum } from './nodebb.js';
import { setSiteAccount, removeSiteAccount, siteAccounts, checkWebPassword } from './users.js';

// ---------- יומן חיפושים וחסימות (נשמר בקבצים בשרת בלבד) ----------
const logFile = () => path.join(cfg.dataDir, 'queries.jsonl');
const blockFile = () => path.join(cfg.dataDir, 'blocked.json');
const norm = (p) => String(p || '').replace(/\D/g, '').slice(-9);

// חסימות: מספר -> { reason, until (0 = לצמיתות), t }
let blocked = new Map();
try {
  const j = JSON.parse(fs.readFileSync(blockFile(), 'utf8'));
  blocked = new Map(Array.isArray(j) ? j.map((p) => (typeof p === 'string' ? [p, { reason: '', until: 0, t: Date.now() }] : p)) : Object.entries(j));
} catch {
  /* אין חסימות עדיין */
}
const saveBlocked = () => {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(blockFile(), JSON.stringify(Object.fromEntries(blocked)), { mode: 0o600 });
};
// חסימה שפג תוקפה משתחררת לבד
const live = (p) => {
  const b = blocked.get(p);
  if (b && b.until && b.until < Date.now()) {
    blocked.delete(p);
    saveBlocked();
    return null;
  }
  return b || null;
};
export const isBlocked = (phone) => !!norm(phone) && !!live(norm(phone));
export const blockInfo = (phone) => (norm(phone) ? live(norm(phone)) : null);
const blockForm = (p, back) => `<form method="post" action="/admin/block"><input type="hidden" name="p" value="${esc(p)}">${back ? '<input type="hidden" name="back" value="1">' : ''}
<input name="reason" maxlength="200" placeholder="סיבת החסימה (תוקרא למתקשר)" style="width:55%"> <select name="d">${Object.entries(DUR_NAME).map(([k, n]) => `<option value="${k}" ${k === 'day' ? 'selected' : ''}>${n}</option>`).join('')}</select> <button class="red">חסום</button></form>`;
const blockText = (b) => `${b.until ? `עד ${new Date(b.until).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}` : 'לצמיתות'}${b.reason ? ` · סיבה: ${b.reason}` : ''}`;

// נרשם מה שהמתקשר אמר (חיפוש, שאלה, שם אתר). תוכן מייל לא נרשם לעולם
function append(rec) {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn('רישום יומן נכשל', e.message);
  }
}
export function logQuery(phone, kind, text) {
  const t = String(text || '').trim();
  if (!t) return;
  append({ t: Date.now(), p: norm(phone) || 'חסוי', k: kind, q: t.slice(0, 500) });
}
// מה שה-AI ענה למתקשר (או אירוע, כמו תחילת שיחה)
export function logAnswer(phone, kind, text, event = false) {
  const t = String(text || '').trim();
  if (!t && !event) return;
  append({ t: Date.now(), p: norm(phone) || 'חסוי', k: kind, ...(event ? { e: 1 } : { a: t.slice(0, 2000) }) });
}

export function recentFor(phone, n = 3) {
  const k = norm(phone);
  return k ? readLog(800).filter((r) => r.p === k && r.q && r.k !== 'שיחה עם AI').slice(0, n) : [];
}

// החדשים ראשונים
function readLog(limit = 50000) {
  try {
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit).reverse()) {
      try { out.push(JSON.parse(l)); } catch { /* שורה פגומה */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ההיסטוריה של מספר אחד (לאיזור האישי באתר), מהישן לחדש
export const historyFor = (phone, n = 150) => {
  const k = norm(phone);
  return readLog(20000).filter((r) => r.p === k && !r.e).slice(0, n).reverse();
};

// מספר מלא לתצוגה: 551234567 -> 0551234567
export const showPhone = (p) => (/^\d{9}$/.test(p) && p[0] !== '0' ? `0${p}` : String(p || ''));

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

// ---------- תפקידים: מנהל הקו (owner) וצוות פיקוח (staff) ----------
export const ownerPhone = () => norm(getSetting('owner', '') || process.env.OWNER_PHONE || '');
export const staffList = () => getSetting('staff', []) || [];
export function roleOf(phone) {
  const p = norm(phone);
  if (!p) return null;
  if (p === ownerPhone()) return 'owner';
  return staffList().some((s) => s.phone === p) ? 'staff' : null;
}
export function addStaff(phone, name = '') {
  const p = norm(phone);
  if (p.length < 9 || p === ownerPhone()) return false;
  setSetting('staff', [...staffList().filter((s) => s.phone !== p), { phone: p, name: String(name).slice(0, 40), t: Date.now() }]);
  return true;
}
export function removeStaff(phone) {
  const p = norm(phone);
  const before = staffList().length;
  setSetting('staff', staffList().filter((s) => s.phone !== p));
  return staffList().length !== before;
}
// קוד כניסה לאתר הניהול שהקו מקריא למנהל או לצוות
const adminCodes = new Map();
export function createAdminCode(phone) {
  const code = String(crypto.randomInt(100000, 1000000));
  adminCodes.set(norm(phone), { code, until: Date.now() + 15 * 60_000, tries: 0 });
  return code;
}

export function checkAdminCode(phone, code) {
  const p = norm(phone);
  const c = adminCodes.get(p);
  if (!c || Date.now() > c.until || ++c.tries > 5 || c.code !== String(code || '').replace(/\D/g, '')) return false;
  adminCodes.delete(p);
  return true;
}
// פתיחת חיבור לאתר המנהל או לאתר הצוות (לכניסה מהדף הראשי)
export function openAdminSession(role, phone = '') {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { until: Date.now() + 12 * 3600_000, role, phone: norm(phone) });
  return role === 'owner'
    ? { cookie: `adm=${sid}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=43200`, to: '/admin' }
    : { cookie: `stf=${sid}; HttpOnly; SameSite=Lax; Path=/staff; Max-Age=43200`, to: '/staff' };
}

// ---------- פעולות ניהול (משותפות לאתר ולקו) ----------
const DUR = { hour: 3600_000, day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, forever: 0 };
const DUR_NAME = { hour: 'שעה', day: 'יום', week: 'שבוע', month: 'חודש', forever: 'לצמיתות' };
export function blockPhone(phone, reason = '', dur = 'day', by = '') {
  const p = norm(phone);
  if (p.length < 9 || p === ownerPhone()) return false;
  const d = DUR[dur] ?? DUR.day;
  blocked.set(p, { reason: String(reason || '').trim().slice(0, 200), until: d ? Date.now() + d : 0, t: Date.now(), by: norm(by) });
  saveBlocked();
  return true;
}
export function unblockPhone(phone) {
  const p = norm(phone);
  const had = blocked.delete(p);
  saveBlocked();
  return had;
}
export const recentAll = (n = 10) => readLog(600).filter((r) => r.q).slice(0, n);
export function phoneSummary(phone) {
  const p = norm(phone);
  const recs = readLog(20000).filter((r) => r.p === p);
  return { calls: recs.filter((r) => r.e).length, last: recs.find((r) => r.q), recent: recs.filter((r) => r.q).slice(0, 5), blocked: live(p) };
}

const sessions = new Map(); // sid -> { until, role }
let fails = [];
const cookieOf = (req, n) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${n}=([^;]+)`));
  return m ? m[1] : '';
};
// באתר הצוות (/staff) העוגייה נקראת אחרת, כך ששני האתרים נפרדים לגמרי
const sidOf = (req) => cookieOf(req, req.staffSite ? 'stf' : 'adm');
const loggedIn = (req) => {
  const s = sessions.get(sidOf(req));
  return s && s.until > Date.now() ? s.role : null;
};

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:16px;color:#222}.card{background:#fff;border-radius:12px;padding:20px;max-width:960px;margin:0 auto 16px;box-shadow:0 2px 10px #0002}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:7px 8px;border-bottom:1px solid #eee;text-align:right;vertical-align:top}input,textarea{padding:8px;font-size:16px;font-family:inherit;box-sizing:border-box}
button,.btn{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}button.red{background:#c62828}button.gray{background:#757575}h1,h2{margin-top:0}
.nav a{margin-left:14px}.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:10px;background:#eef3fd;color:#1a73e8}.tag.red{background:#fdecea;color:#c62828}.tag.green{background:#e8f5e9;color:#2e7d32}
.msg{padding:10px 14px;border-radius:12px;margin:8px 0;max-width:80%;white-space:pre-wrap;line-height:1.5}.me{background:#e3f2fd;margin-left:auto}.bot{background:#f1f1f1;margin-right:auto}.ev{text-align:center;color:#888;font-size:13px;margin:14px 0 4px}
.time{font-size:12px;color:#888;margin-bottom:2px}.day{text-align:center;font-weight:bold;color:#555;margin:22px 0 6px;border-top:1px solid #eee;padding-top:10px}</style></head><body>${body}</body></html>`;

const fmt = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
const navOwner = '<div class="card nav"><a href="/admin">תיקים</a><a href="/admin/live">שיחות אחרונות</a><a href="/admin/rules">הוראות ל-AI</a><a href="/admin/chat">שיחה עם ה-AI</a><a href="/admin/blocks">חסימות</a><a href="/admin/settings">הגדרות, צוות ומפתחות</a><a href="/admin/me"><b>האיזור האישי שלי</b></a><form method="post" action="/admin/logout" style="display:inline;float:left"><button class="gray">יציאה</button></form></div>';
const navStaff = '<div class="card nav"><b>אתר צוות הפיקוח</b> · <a href="/admin">תיקים</a><a href="/admin/live">שיחות אחרונות</a><a href="/admin/blocks">חסימות</a><a href="/admin/me"><b>האיזור האישי שלי</b></a><form method="post" action="/admin/logout" style="display:inline;float:left"><button class="gray">יציאה</button></form></div>';
const navFor = (role) => (role === 'staff' ? navStaff : navOwner);
const usersDb = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'users.json'), 'utf8'));
  } catch {
    return {};
  }
};

// תיק לכל מספר: כמה פעולות, מתי לאחרונה, ומה נאמר לאחרונה
function folders() {
  const by = new Map();
  for (const r of readLog()) {
    let f = by.get(r.p);
    if (!f) by.set(r.p, (f = { p: r.p, n: 0, calls: 0, last: r.t, lastQ: '' }));
    if (r.e) f.calls++;
    else f.n++;
    if (!f.lastQ && r.q) f.lastQ = r.q;
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

function accountsCard(p, msg) {
  const acc = siteAccounts(p);
  const rows = Object.entries(FORUMS).map(([host, name]) => {
    const a = acc.find((x) => x.host === host);
    return a
      ? `<p>${esc(name)}: מחובר בתור <b>${esc(a.username)}</b> <form method="post" action="/admin/site-account" style="display:inline"><input type="hidden" name="p" value="${esc(p)}"><input type="hidden" name="host" value="${esc(host)}"><input type="hidden" name="remove" value="1"><button class="red">נתק</button></form></p>`
      : `<form method="post" action="/admin/site-account"><input type="hidden" name="p" value="${esc(p)}"><input type="hidden" name="host" value="${esc(host)}"><b>${esc(name)}:</b> <input name="u" placeholder="שם משתמש או מייל" autocomplete="off"> <input name="pw" type="password" placeholder="סיסמה" autocomplete="new-password"> <button>חבר</button></form>`;
  }).join('');
  return `<div class="card"><h2>חשבונות באתרים</h2>${msg ? `<p style="color:#1a73e8">${esc(msg)}</p>` : ''}${rows}<p style="color:#666;font-size:13px">הסיסמה נבדקת מול האתר ונשמרת מוצפנת בשרת. היא לא מוצגת כאן ולא נשמרת ביומן. כך העוזר בקו יוכל לקרוא, לכתוב פוסטים ולקרוא צ'אטים בחשבון הזה.</p></div>`;
}

// היסטוריית השיחה של המנהל עם ה-AI (נשמרת בשרת)
const chatFile = () => path.join(cfg.dataDir, 'admin-chat.json');
let adminHist = [];
try {
  adminHist = JSON.parse(fs.readFileSync(chatFile(), 'utf8'));
} catch {
  /* חדש */
}
const saveChat = () => {
  adminHist = adminHist.slice(-200);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(chatFile(), JSON.stringify(adminHist), { mode: 0o600 });
};

export function lineContext() {
  const fs_ = folders();
  const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const recent = readLog(400).filter((r) => r.q).slice(0, 40).map((r) => `${fmt(r.t)} ${showPhone(r.p)} (${r.k}): ${r.q.slice(0, 120)}`);
  return `${fs_.length} מספרים התקשרו בסך הכל. היום ${today}. חסומים: ${[...blocked.keys()].map(showPhone).join(', ') || 'אין'}. הדברים האחרונים שנאמרו בקו: ${recent.join(' ; ') || 'אין'}`;
}

export function addAdminRoutes(app) {
  // אתר נפרד לצוות הפיקוח: /staff. אותם דפים מותרים (תיקים, שיחות, חסימות), בכתובת ובכניסה משלו
  app.use((req, res, next) => {
    if (req.path !== '/staff' && !req.path.startsWith('/staff/')) return next();
    req.staffSite = true;
    req.url = `/admin${req.url.slice('/staff'.length)}`;
    const fix = (x) => (typeof x === 'string' ? x.replaceAll('"/admin', '"/staff') : x);
    const send = res.send.bind(res);
    res.send = (b) => send(fix(b));
    const redirect = res.redirect.bind(res);
    res.redirect = (...a) => {
      a[a.length - 1] = String(a[a.length - 1]).replace(/^\/admin/, '/staff');
      return redirect(...a);
    };
    const set = res.set.bind(res);
    res.set = (k, v) => (typeof k === 'object' ? set(k) : set(k, k === 'set-cookie' && typeof v === 'string' ? v.replace(/^adm=/, 'stf=').replace('Path=/admin', 'Path=/staff') : v));
    next();
  });
  app.use('/admin', (req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    next();
  });
  // need: 'staff' (צוות פיקוח ומעלה) או 'owner' (רק מנהל הקו)
  const gate = (req, res, need = 'owner') => {
    let role = loggedIn(req);
    if (req.staffSite && role) {
      // באתר הצוות כולם פועלים בהרשאות צוות
      role = 'staff';
      if (need === 'owner') {
        res.status(403).send(shell('אין הרשאה', `${navStaff}<div class="card"><p>הדף הזה לא קיים באתר הצוות.</p></div>`));
        return false;
      }
    }
    if (!req.staffSite && role === 'staff') {
      res.status(403).send(shell('אתר הצוות', '<div class="card"><p>אתר הצוות נמצא בכתובת נפרדת: <a href="/staff">/staff</a></p></div>'));
      return false;
    }
    if (role === 'owner' || (role === 'staff' && need === 'staff')) {
      req.role = role;
      return true;
    }
    if (req.method !== 'GET') {
      res.status(403).send('אין גישה');
      return false;
    }
    // כניסה אחת לכולם בדף הראשי
    res.redirect('/');
    return false;
  };

  // מעבר לאיזור האישי (חיבור גוגל, מייל, פורום, הגדרות) בלי כניסה נוספת
  app.get('/admin/me', async (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const phone = sessions.get(sidOf(req))?.phone || ownerPhone();
    if (!phone) return res.send(shell('האיזור האישי', `${navFor(req.role)}<div class="card"><p>לא מוגדר מספר טלפון למנהל הקו, ולכן אין איזור אישי.</p></div>`));
    const { openMySession } = await import('./my.js');
    res.set('set-cookie', openMySession(phone));
    res.redirect('/my');
  });

  // ---- דף ראשי: רשימת תיקים, מספר אחד בשורה אחת ----
  app.get('/admin', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const db = usersDb();
    const q = String(req.query.q || '').replace(/\D/g, '');
    const list = folders().filter((f) => !q || showPhone(f.p).includes(q));
    const rows = list.map((f) => {
      const tags = [live(f.p) ? '<span class="tag red">חסום</span>' : '', db[f.p]?.app || db[f.p]?.google ? '<span class="tag green">מייל מחובר</span>' : ''].join(' ');
      return `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(f.p)}"><b>${esc(showPhone(f.p))}</b></a></td><td>${f.calls || '-'}</td><td>${f.n}</td><td>${fmt(f.last)}</td><td>${esc(f.lastQ.slice(0, 70))}</td><td>${tags}</td><td><a class="btn" href="/admin/p/${encodeURIComponent(f.p)}">פתח תיק</a></td></tr>`;
    }).join('') || '<tr><td colspan="7">עדיין אין שיחות</td></tr>';
    res.send(shell('ניהול', `${navFor(req.role)}<div class="card"><h1>תיקי מתקשרים (${list.length})</h1>
<form method="get" action="/admin"><input name="q" placeholder="חיפוש לפי מספר" dir="ltr" value="${esc(q)}"> <button>חפש</button></form><br>
<table><tr><th>מספר</th><th>שיחות</th><th>פעולות</th><th>פעילות אחרונה</th><th>נאמר לאחרונה</th><th></th><th></th></tr>${rows}</table></div>`));
  });

  // ---- תיק של מספר אחד: כל מה שאמר וכל מה שה-AI ענה, לפי שעה ----
  app.get('/admin/p/:p', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const p = req.params.p === 'חסוי' ? 'חסוי' : norm(req.params.p);
    const recs = readLog().filter((r) => r.p === p).reverse();
    const db = usersDb()[p];
    let day = '';
    const body = recs.map((r) => {
      const d = fmtDay(r.t);
      const head = d !== day ? `<div class="day">${esc((day = d))}</div>` : '';
      if (r.e) return `${head}<div class="ev">${fmtTime(r.t)} · ${esc(r.k)}</div>`;
      if (r.a) return `${head}<div class="msg bot"><div class="time">${fmtTime(r.t)} · ${esc(r.k)}</div>${esc(r.a)}</div>`;
      return `${head}<div class="msg me"><div class="time">${fmtTime(r.t)} · ${esc(r.k)}</div>${esc(r.q)}</div>`;
    }).join('') || '<p>אין רישומים למספר הזה.</p>';
    const bi = live(p);
    const isB = !!bi;
    const act = p === 'חסוי' ? '' : isB
      ? `<p style="color:#c62828">חסום ${esc(blockText(bi))}</p><form method="post" action="/admin/unblock"><input type="hidden" name="p" value="${esc(p)}"><input type="hidden" name="back" value="1"><button>שחרר חסימה</button></form>`
      : blockForm(p, true);
    const calls = recs.filter((r) => r.e).length;
    res.send(shell(`תיק ${showPhone(p)}`, `${navFor(req.role)}<div class="card"><h1 dir="ltr" style="text-align:right">${esc(showPhone(p))}</h1>
<p>${calls} שיחות · ${recs.length - calls} פעולות · ${recs.length ? `ראשונה ${fmt(recs[0].t)} · אחרונה ${fmt(recs[recs.length - 1].t)}` : ''} ${isB ? '<span class="tag red">חסום</span>' : ''} ${db?.app || db?.google ? `<span class="tag green">מייל מחובר</span>` : ''}</p>${act}
${db?.prefs?.length ? `<p><b>מה העוזר זוכר על המתקשר:</b> ${db.prefs.map(esc).join(' · ')}</p>` : ''}<p style="color:#666;font-size:13px">בכחול: מה שהמתקשר אמר. באפור: מה שה-AI ענה. תוכן מיילים לא נשמר ולא מוצג.</p></div>
${p === 'חסוי' || req.role !== 'owner' ? '' : accountsCard(p, req.query.m)}<div class="card">${body}</div>`));
  });

  // חיבור חשבון פורום למספר: הסיסמה נבדקת מול הפורום, ונשמרת מוצפנת. לא מוצגת אף פעם
  app.post('/admin/site-account', async (req, res) => {
    if (!gate(req, res)) return;
    const p = norm(req.body?.p);
    const host = String(req.body?.host || '');
    const back = (m) => res.redirect(`/admin/p/${encodeURIComponent(p)}?m=${encodeURIComponent(m)}`);
    if (!FORUMS[host] || p.length < 9) return back('פרטים לא תקינים');
    if (req.body?.remove) {
      removeSiteAccount(p, host);
      dropForum(p, host);
      return back('החשבון נותק');
    }
    const u = String(req.body?.u || '').trim();
    const pw = String(req.body?.pw || '');
    if (!u || !pw) return back('צריך שם משתמש וסיסמה');
    try {
      const f = new Forum(host);
      const me = await f.login(u, pw);
      setSiteAccount(p, host, u, pw);
      dropForum(p, host);
      back(`מחובר בהצלחה בתור ${me.username || u}`);
    } catch (e) {
      back(`החיבור נכשל: ${String(e.message).slice(0, 150)}`);
    }
  });

  // ---- שיחות אחרונות: מה שאלו ומה ה-AI ענה, מכל המספרים ----
  app.get('/admin/live', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const recs = readLog(600).filter((r) => !r.e).slice(0, 300);
    const rows = recs.map((r) => `<tr><td style="white-space:nowrap">${fmt(r.t)}</td><td dir="ltr" style="text-align:right;white-space:nowrap"><a href="/admin/p/${encodeURIComponent(r.p)}">${esc(showPhone(r.p))}</a></td><td style="white-space:nowrap">${esc(r.k)}</td><td><div class="msg ${r.a ? 'bot' : 'me'}" style="max-width:100%;margin:0">${esc(r.a || r.q)}</div></td></tr>`).join('') || '<tr><td>אין עדיין</td></tr>';
    res.send(shell('שיחות אחרונות', `${navFor(req.role)}<div class="card"><h1>שיחות אחרונות</h1><p>בכחול מה שהמתקשרים אמרו, באפור מה שה-AI ענה. החדשים למעלה. <a href="/admin/live">רענן</a></p><table>${rows}</table></div>`));
  });

  app.post('/admin/shortcut', (req, res) => {
    if (!gate(req, res)) return;
    let url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const list = (getSetting('shortcuts', []) || []).filter((x) => x.name !== name);
    if (name) list.push({ name, url });
    setSetting('shortcuts', list);
    res.redirect('/admin/settings');
  });
  app.post('/admin/shortcut/del', (req, res) => {
    if (!gate(req, res)) return;
    const list = getSetting('shortcuts', []) || [];
    list.splice(Number(req.body?.i), 1);
    setSetting('shortcuts', list);
    res.redirect('/admin/settings');
  });

  app.post('/admin/limit', (req, res) => {
    if (!gate(req, res)) return;
    setSetting('dailyLimit', Math.max(0, Math.min(1000, Number(req.body?.n) || 0)));
    res.redirect('/admin/settings');
  });

  // ---- הוראות ל-AI ----
  app.get('/admin/rules', (req, res) => {
    if (!gate(req, res)) return;
    const rows = listRules().map((r) => `<tr><td>${esc(r.text)}</td><td style="white-space:nowrap">${fmt(r.t)}</td><td><form method="post" action="/admin/rules/remove"><input type="hidden" name="id" value="${esc(r.id)}"><button class="red">מחק</button></form></td></tr>`).join('') || '<tr><td>אין הוראות. ה-AI עונה לפי ההגדרות הרגילות.</td></tr>';
    res.send(shell('הוראות ל-AI', `${navFor(req.role)}<div class="card"><h1>הוראות ל-AI בקו</h1><p>כל הוראה כאן מחייבת את ה-AI בכל שיחה בקו, מיד, לכל המתקשרים. למשל: "אל תדבר על ספורט", "ענה תמיד בקצרה מאוד", "אם שואלים על המחיר, אמור שהשירות חינם".</p>
<form method="post" action="/admin/rules/add"><textarea name="text" rows="2" style="width:100%" placeholder="כתוב הוראה חדשה" required></textarea><br><br><button>הוסף הוראה</button></form><br>
<table><tr><th>הוראה</th><th>נוספה</th><th></th></tr>${rows}</table><p>אפשר גם לתת הוראות בשיחה רגילה בדף <a href="/admin/chat">שיחה עם ה-AI</a>.</p></div>`));
  });
  app.post('/admin/rules/add', (req, res) => {
    if (!gate(req, res)) return;
    addRule(req.body?.text);
    res.redirect('/admin/rules');
  });
  app.post('/admin/rules/remove', (req, res) => {
    if (!gate(req, res)) return;
    removeRule(req.body?.id);
    res.redirect('/admin/rules');
  });

  // ---- שיחה עם ה-AI ----
  app.get('/admin/chat', (req, res) => {
    if (!gate(req, res)) return;
    const msgs = adminHist.map((m) => `<div class="msg ${m.role === 'admin' ? 'me' : 'bot'}"><div class="time">${fmt(m.t)}</div>${esc(m.text)}${m.note ? `<div class="time" style="margin-top:6px">${esc(m.note)}</div>` : ''}</div>`).join('') || '<p>אפשר לכתוב ל-AI כל דבר: לשאול מה קורה בקו, או לתת הוראות, למשל "מעכשיו אל תענה על שאלות על פוליטיקה". הוא יענה לך, וההוראות שהוא שומר מופיעות בדף ההוראות.</p>';
    res.send(shell('שיחה עם ה-AI', `${navFor(req.role)}<div class="card"><h1>שיחה עם ה-AI</h1><div id="log">${msgs}</div>
<form method="post" action="/admin/chat" id="f"><textarea name="text" rows="3" style="width:100%" placeholder="כתוב הודעה" required autofocus></textarea><br><br><button id="b">שלח</button>
<button class="gray" formaction="/admin/chat/clear" formnovalidate>נקה שיחה</button></form></div>
<script>window.scrollTo(0,document.body.scrollHeight);document.getElementById('f').addEventListener('submit',function(){var b=document.getElementById('b');b.disabled=true;b.textContent='חושב...'});</script>`));
  });
  app.post('/admin/chat', async (req, res) => {
    if (!gate(req, res)) return;
    const text = String(req.body?.text || '').trim().slice(0, 3000);
    if (!text) return res.redirect('/admin/chat');
    let r;
    try {
      r = await adminChat(adminHist, text, lineContext());
    } catch (e) {
      r = { reply: `לא הצלחתי לענות כרגע (${String(e.message).slice(0, 80)})`, add: [], remove: [] };
    }
    const notes = [];
    for (const t of r.add) if (addRule(t)) notes.push(`נוספה הוראה: ${t}`);
    for (const id of r.remove) {
      const old = listRules().find((x) => x.id === id);
      if (old && removeRule(id)) notes.push(`הוסרה הוראה: ${old.text}`);
    }
    adminHist.push({ role: 'admin', text, t: Date.now() }, { role: 'ai', text: r.reply, t: Date.now(), note: notes.join(' · ') });
    saveChat();
    res.redirect('/admin/chat');
  });
  app.post('/admin/chat/clear', (req, res) => {
    if (!gate(req, res)) return;
    adminHist = [];
    saveChat();
    res.redirect('/admin/chat');
  });

  // ---- חסימות ומפתחות ----
  app.get('/admin/settings', (req, res) => {
    if (!gate(req, res)) return;
    const db = usersDb();
    const bl = [...blocked.keys()].filter((p) => live(p)).map((p) => `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(p)}">${esc(showPhone(p))}</a></td><td>${esc(blockText(blocked.get(p)))}</td><td><form method="post" action="/admin/unblock"><input type="hidden" name="p" value="${esc(p)}"><button>שחרר</button></form></td></tr>`).join('') || '<tr><td>אין חסומים</td></tr>';
    const connected = Object.keys(db).filter((p) => db[p]?.app || db[p]?.google);
    const staffRows = staffList().map((x) => `<tr><td dir="ltr" style="text-align:right">${esc(showPhone(x.phone))}</td><td>${esc(x.name || '')}</td><td><form method="post" action="/admin/staff/del"><input type="hidden" name="p" value="${esc(x.phone)}"><button class="red">הסר</button></form></td></tr>`).join('') || '<tr><td>אין עדיין</td></tr>';
    res.send(shell('הגדרות', `${navFor(req.role)}<div class="card"><h2>מנהל הקו וצוות פיקוח</h2>
<form method="post" action="/admin/owner">מספר הטלפון של מנהל הקו (מקבל תפריט ניהול מלא בקו, בהקשה 9): <input name="p" dir="ltr" value="${esc(showPhone(ownerPhone()))}" placeholder="05XXXXXXXX"> <button>שמור</button></form>
<p>צוות הפיקוח יכול לראות תיקים ושיחות ולחסום או לשחרר מתקשרים, בקו ובאתר. הם לא יכולים לשנות את הוראות ה-AI, ההגדרות, המפתחות או את הצוות.</p>
<p>לצוות יש אתר נפרד: <a href="/staff" target="_blank">/staff</a>. שם הם רואים תיקים ושיחות, וחוסמים ומשחררים. הם נכנסים עם מספר הטלפון וקוד מהקו (9 ואז 5), או עם סיסמה קבועה שבחרו באיזור האישי.</p><table>${staffRows}</table><form method="post" action="/admin/staff"><input name="p" dir="ltr" placeholder="מספר טלפון" required> <input name="name" placeholder="שם (לא חובה)"> <button>הוסף לצוות</button></form></div>
<div class="card"><h2>מספרים עם מייל מחובר (${connected.length})</h2><p>מוצגים רק מספרים. תוכן המייל והסיסמאות לא נראים כאן.</p><table>${connected.map((p) => `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(p)}">${esc(showPhone(p))}</a></td></tr>`).join('') || '<tr><td>אין</td></tr>'}</table></div>
<div class="card"><h2>קיצורי אתרים לכל המתקשרים</h2><table>${(getSetting('shortcuts', []) || []).map((x, i) => `<tr><td><b>${esc(x.name)}</b></td><td dir="ltr">${esc(x.url)}</td><td><form method="post" action="/admin/shortcut/del"><input type="hidden" name="i" value="${i}"><button class="red">מחק</button></form></td></tr>`).join('') || '<tr><td>אין</td></tr>'}</table>
<form method="post" action="/admin/shortcut"><input name="name" placeholder="שם, למשל: חדשות" required> <input name="url" dir="ltr" placeholder="https://..." required> <button>הוסף</button></form></div>
<div class="card"><h2>תומכי הקו</h2><p>מי שתורם מפתח Groq ומקשר אותו למספר שלו מקבל: עדיפות במהירות (המפתח שלו משמש קודם אותו), שאלות ללא הגבלה, תשובות מורחבות, זיכרון גדול וברכה אישית. דף ההצטרפות: <a href="/donate" target="_blank">/donate</a></p>
<form method="post" action="/admin/limit">מכסת שאלות יומית למי שאינו תומך: <input name="n" type="number" min="0" max="1000" value="${Number(getSetting('dailyLimit', 0))}" style="width:90px"> <button>שמור</button> <span style="color:#666;font-size:13px">(0 = ללא הגבלה)</span></form></div>
<div class="card"><h2>מצב המפתחות (מאז ההפעלה)</h2><table><tr><th>מפתח</th><th>הצליחו</th><th>נכשלו</th><th>זמן תגובה ממוצע</th><th></th></tr>${keyStats().map((k) => `<tr><td dir="ltr">…${esc(k.tail)}</td><td>${k.ok}</td><td>${k.fail}</td><td>${k.ms ? (k.ms / 1000).toFixed(1) + ' שנ׳' : '-'}</td><td>${k.resting ? '<span class="tag red">נח (מגבלת קצב)</span>' : '<span class="tag green">פעיל</span>'}</td></tr>`).join('') || '<tr><td>עדיין לא היו בקשות</td></tr>'}</table></div>
<div class="card"><h2>מפתחות Groq שנתרמו (${poolList().length})</h2><p>מוצגות רק 4 ספרות אחרונות.</p><table>${poolList().map((k) => `<tr><td dir="ltr">…${esc(k.tail)}</td><td dir="ltr">${k.phone ? `<a href="/admin/p/${encodeURIComponent(norm(k.phone))}">${esc(k.phone)}</a>` : '-'}</td><td><form method="post" action="/admin/pool-remove"><input type="hidden" name="t" value="${esc(k.tail)}"><button class="red">הסר</button></form></td></tr>`).join('') || '<tr><td>אין</td></tr>'}</table></div>`));
  });

  app.get('/admin/blocks', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const bl = [...blocked.keys()].filter((p) => live(p)).map((p) => `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(p)}">${esc(showPhone(p))}</a></td><td>${esc(blockText(blocked.get(p)))}</td><td><form method="post" action="/admin/unblock"><input type="hidden" name="p" value="${esc(p)}"><button>שחרר</button></form></td></tr>`).join('') || '<tr><td>אין חסומים</td></tr>';
    res.send(shell('חסימות', `${navFor(req.role)}<div class="card"><h2>חסימת מספר</h2><form method="post" action="/admin/block"><input name="p" placeholder="מספר טלפון" dir="ltr" required> <input name="reason" maxlength="200" placeholder="סיבת החסימה (תוקרא למתקשר)"> <select name="d">${Object.entries(DUR_NAME).map(([k, n]) => `<option value="${k}" ${k === 'day' ? 'selected' : ''}>${n}</option>`).join('')}</select> <button class="red">חסום</button></form><br><table>${bl}</table></div>`));
  });
  app.post('/admin/staff', (req, res) => {
    if (!gate(req, res)) return;
    addStaff(req.body?.p, req.body?.name);
    res.redirect('/admin/settings');
  });
  app.post('/admin/staff/del', (req, res) => {
    if (!gate(req, res)) return;
    removeStaff(req.body?.p);
    res.redirect('/admin/settings');
  });
  app.post('/admin/owner', (req, res) => {
    if (!gate(req, res)) return;
    const p = norm(req.body?.p);
    if (p.length >= 9) setSetting('owner', p);
    res.redirect('/admin/settings');
  });
  // כניסה עם קוד שהקו הקריא (למנהל ולצוות)
  app.post('/admin/login-code', (req, res) => {
    fails = fails.filter((t) => Date.now() - t < 15 * 60_000);
    if (fails.length >= 8) return res.status(429).send(shell('נחסם', '<div class="card"><p>יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.</p></div>'));
    const p = norm(req.body?.phone);
    const c = adminCodes.get(p);
    const real = roleOf(p);
    // אתר המנהל: רק מנהל הקו. אתר הצוות: הצוות (וגם המנהל)
    const role = req.staffSite ? (real ? 'staff' : null) : real === 'owner' ? 'owner' : null;
    const given = String(req.body?.code || '');
    const codeOk = c && Date.now() <= c.until && ++c.tries <= 5 && c.code === given.replace(/\D/g, '');
    if (!role || !(codeOk || checkWebPassword(p, given))) {
      fails.push(Date.now());
      return res.redirect('/admin?e=1');
    }
    if (codeOk) adminCodes.delete(p);
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { until: Date.now() + 12 * 3600_000, role, phone: p });
    res.set('set-cookie', `adm=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`);
    res.redirect('/admin');
  });

  app.post('/admin/login', (req, res) => {
    fails = fails.filter((t) => Date.now() - t < 15 * 60_000);
    if (fails.length >= 8) return res.status(429).send(shell('נחסם', '<div class="card"><p>יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.</p></div>'));
    if (!verifyPassword(req.body?.u || '', req.body?.p || '')) {
      fails.push(Date.now());
      return res.redirect('/admin?e=1');
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, { until: Date.now() + 12 * 3600_000, role: 'owner' });
    res.set('set-cookie', `adm=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`);
    res.redirect('/admin');
  });
  app.post('/admin/logout', (req, res) => {
    sessions.delete(sidOf(req));
    res.set('set-cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
    res.redirect('/admin');
  });
  const backTo = (req, p) => (req.body?.back ? `/admin/p/${encodeURIComponent(p)}` : '/admin/blocks');
  app.post('/admin/block', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const p = norm(req.body?.p);
    blockPhone(p, req.body?.reason, req.body?.d, sessions.get(sidOf(req))?.phone);
    res.redirect(backTo(req, p));
  });
  app.post('/admin/unblock', (req, res) => {
    if (!gate(req, res, 'staff')) return;
    const p = norm(req.body?.p);
    unblockPhone(p);
    res.redirect(backTo(req, p));
  });
  app.post('/admin/pool-remove', (req, res) => {
    if (!gate(req, res)) return;
    removeByTail(String(req.body?.t || '').slice(-4));
    res.redirect('/admin/settings');
  });
}
