import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';
import * as users from './users.js';
import { poolList, removeByTail } from './pool.js';
import { listRules, addRule, removeRule } from './rules.js';
import { adminChat } from './ai.js';
import { keyStats } from './llm.js';
import { Forum, FORUMS, dropForum } from './nodebb.js';
import { setSiteAccount, removeSiteAccount, siteAccounts } from './users.js';

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
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:16px;color:#222}.card{background:#fff;border-radius:12px;padding:20px;max-width:960px;margin:0 auto 16px;box-shadow:0 2px 10px #0002}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:7px 8px;border-bottom:1px solid #eee;text-align:right;vertical-align:top}input,textarea{padding:8px;font-size:16px;font-family:inherit;box-sizing:border-box}
button,.btn{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}button.red{background:#c62828}button.gray{background:#757575}h1,h2{margin-top:0}
.nav a{margin-left:14px}.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:10px;background:#eef3fd;color:#1a73e8}.tag.red{background:#fdecea;color:#c62828}.tag.green{background:#e8f5e9;color:#2e7d32}
.msg{padding:10px 14px;border-radius:12px;margin:8px 0;max-width:80%;white-space:pre-wrap;line-height:1.5}.me{background:#e3f2fd;margin-left:auto}.bot{background:#f1f1f1;margin-right:auto}.ev{text-align:center;color:#888;font-size:13px;margin:14px 0 4px}
.time{font-size:12px;color:#888;margin-bottom:2px}.day{text-align:center;font-weight:bold;color:#555;margin:22px 0 6px;border-top:1px solid #eee;padding-top:10px}</style></head><body>${body}</body></html>`;

const fmt = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
const nav = '<div class="card nav"><a href="/admin">תיקים</a><a href="/admin/rules">הוראות ל-AI</a><a href="/admin/chat">שיחה עם ה-AI</a><a href="/admin/settings">חסימות ומפתחות</a><form method="post" action="/admin/logout" style="display:inline;float:left"><button class="gray">יציאה</button></form></div>';
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

function lineContext() {
  const fs_ = folders();
  const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const recent = readLog(400).filter((r) => r.q).slice(0, 40).map((r) => `${fmt(r.t)} ${showPhone(r.p)} (${r.k}): ${r.q.slice(0, 120)}`);
  return `${fs_.length} מספרים התקשרו בסך הכל. היום ${today}. חסומים: ${[...blocked].map(showPhone).join(', ') || 'אין'}. הדברים האחרונים שנאמרו בקו: ${recent.join(' ; ') || 'אין'}`;
}

export function addAdminRoutes(app) {
  app.use('/admin', (req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    next();
  });
  const gate = (req, res) => {
    if (!hashEnv()) {
      res.status(503).send(shell('ניהול', '<div class="card"><p>סיסמת הניהול עדיין לא הוגדרה בשרת.</p></div>'));
      return false;
    }
    if (loggedIn(req)) return true;
    if (req.method !== 'GET') {
      res.status(403).send('אין גישה');
      return false;
    }
    const bad = req.query.e ? '<p style="color:#c62828">פרטים שגויים</p>' : '';
    res.send(shell('כניסה', `<div class="card" style="max-width:360px"><h1>כניסה לניהול</h1>${bad}<form method="post" action="/admin/login"><p><input name="u" placeholder="שם משתמש" autocomplete="username" style="width:100%"></p><p><input name="p" type="password" placeholder="סיסמה" autocomplete="current-password" style="width:100%"></p><button>כניסה</button></form></div>`));
    return false;
  };

  // ---- דף ראשי: רשימת תיקים, מספר אחד בשורה אחת ----
  app.get('/admin', (req, res) => {
    if (!gate(req, res)) return;
    const db = usersDb();
    const q = String(req.query.q || '').replace(/\D/g, '');
    const list = folders().filter((f) => !q || showPhone(f.p).includes(q));
    const rows = list.map((f) => {
      const tags = [blocked.has(f.p) ? '<span class="tag red">חסום</span>' : '', db[f.p]?.app || db[f.p]?.google ? '<span class="tag green">מייל מחובר</span>' : ''].join(' ');
      return `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(f.p)}"><b>${esc(showPhone(f.p))}</b></a></td><td>${f.calls || '-'}</td><td>${f.n}</td><td>${fmt(f.last)}</td><td>${esc(f.lastQ.slice(0, 70))}</td><td>${tags}</td><td><a class="btn" href="/admin/p/${encodeURIComponent(f.p)}">פתח תיק</a></td></tr>`;
    }).join('') || '<tr><td colspan="7">עדיין אין שיחות</td></tr>';
    res.send(shell('ניהול', `${nav}<div class="card"><h1>תיקי מתקשרים (${list.length})</h1>
<form method="get" action="/admin"><input name="q" placeholder="חיפוש לפי מספר" dir="ltr" value="${esc(q)}"> <button>חפש</button></form><br>
<table><tr><th>מספר</th><th>שיחות</th><th>פעולות</th><th>פעילות אחרונה</th><th>נאמר לאחרונה</th><th></th><th></th></tr>${rows}</table></div>`));
  });

  // ---- תיק של מספר אחד: כל מה שאמר וכל מה שה-AI ענה, לפי שעה ----
  app.get('/admin/p/:p', (req, res) => {
    if (!gate(req, res)) return;
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
    const isB = blocked.has(p);
    const act = p === 'חסוי' ? '' : `<form method="post" action="/admin/${isB ? 'unblock' : 'block'}"><input type="hidden" name="p" value="${esc(p)}"><input type="hidden" name="back" value="1"><button class="${isB ? '' : 'red'}">${isB ? 'שחרר חסימה' : 'חסום מספר זה'}</button></form>`;
    const calls = recs.filter((r) => r.e).length;
    res.send(shell(`תיק ${showPhone(p)}`, `${nav}<div class="card"><h1 dir="ltr" style="text-align:right">${esc(showPhone(p))}</h1>
<p>${calls} שיחות · ${recs.length - calls} פעולות · ${recs.length ? `ראשונה ${fmt(recs[0].t)} · אחרונה ${fmt(recs[recs.length - 1].t)}` : ''} ${isB ? '<span class="tag red">חסום</span>' : ''} ${db?.app || db?.google ? `<span class="tag green">מייל מחובר</span>` : ''}</p>${act}
${db?.prefs?.length ? `<p><b>מה העוזר זוכר על המתקשר:</b> ${db.prefs.map(esc).join(' · ')}</p>` : ''}<p style="color:#666;font-size:13px">בכחול: מה שהמתקשר אמר. באפור: מה שה-AI ענה. תוכן מיילים לא נשמר ולא מוצג.</p></div>
${p === 'חסוי' ? '' : accountsCard(p, req.query.m)}<div class="card">${body}</div>`));
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

  // ---- הוראות ל-AI ----
  app.get('/admin/rules', (req, res) => {
    if (!gate(req, res)) return;
    const rows = listRules().map((r) => `<tr><td>${esc(r.text)}</td><td style="white-space:nowrap">${fmt(r.t)}</td><td><form method="post" action="/admin/rules/remove"><input type="hidden" name="id" value="${esc(r.id)}"><button class="red">מחק</button></form></td></tr>`).join('') || '<tr><td>אין הוראות. ה-AI עונה לפי ההגדרות הרגילות.</td></tr>';
    res.send(shell('הוראות ל-AI', `${nav}<div class="card"><h1>הוראות ל-AI בקו</h1><p>כל הוראה כאן מחייבת את ה-AI בכל שיחה בקו, מיד, לכל המתקשרים. למשל: "אל תדבר על ספורט", "ענה תמיד בקצרה מאוד", "אם שואלים על המחיר, אמור שהשירות חינם".</p>
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
    res.send(shell('שיחה עם ה-AI', `${nav}<div class="card"><h1>שיחה עם ה-AI</h1><div id="log">${msgs}</div>
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
    const bl = [...blocked].map((p) => `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(p)}">${esc(showPhone(p))}</a></td><td><form method="post" action="/admin/unblock"><input type="hidden" name="p" value="${esc(p)}"><button>שחרר</button></form></td></tr>`).join('') || '<tr><td>אין חסומים</td></tr>';
    const connected = Object.keys(db).filter((p) => db[p]?.app || db[p]?.google);
    res.send(shell('חסימות ומפתחות', `${nav}<div class="card"><h2>חסימת מספר</h2><form method="post" action="/admin/block"><input name="p" placeholder="מספר טלפון" dir="ltr"> <button class="red">חסום</button></form><br><table>${bl}</table></div>
<div class="card"><h2>מספרים עם מייל מחובר (${connected.length})</h2><p>מוצגים רק מספרים. תוכן המייל והסיסמאות לא נראים כאן.</p><table>${connected.map((p) => `<tr><td dir="ltr" style="text-align:right"><a href="/admin/p/${encodeURIComponent(p)}">${esc(showPhone(p))}</a></td></tr>`).join('') || '<tr><td>אין</td></tr>'}</table></div>
<div class="card"><h2>מצב המפתחות (מאז ההפעלה)</h2><table><tr><th>מפתח</th><th>הצליחו</th><th>נכשלו</th><th>זמן תגובה ממוצע</th><th></th></tr>${keyStats().map((k) => `<tr><td dir="ltr">…${esc(k.tail)}</td><td>${k.ok}</td><td>${k.fail}</td><td>${k.ms ? (k.ms / 1000).toFixed(1) + ' שנ׳' : '-'}</td><td>${k.resting ? '<span class="tag red">נח (מגבלת קצב)</span>' : '<span class="tag green">פעיל</span>'}</td></tr>`).join('') || '<tr><td>עדיין לא היו בקשות</td></tr>'}</table></div>
<div class="card"><h2>מפתחות Groq שנתרמו (${poolList().length})</h2><p>מוצגות רק 4 ספרות אחרונות.</p><table>${poolList().map((k) => `<tr><td dir="ltr">…${esc(k.tail)}</td><td><form method="post" action="/admin/pool-remove"><input type="hidden" name="t" value="${esc(k.tail)}"><button class="red">הסר</button></form></td></tr>`).join('') || '<tr><td>אין</td></tr>'}</table></div>`));
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
  app.post('/admin/logout', (req, res) => {
    sessions.delete(cookieOf(req, 'adm'));
    res.set('set-cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
    res.redirect('/admin');
  });
  const backTo = (req, p) => (req.body?.back ? `/admin/p/${encodeURIComponent(p)}` : '/admin/settings');
  app.post('/admin/block', (req, res) => {
    if (!gate(req, res)) return;
    const p = norm(req.body?.p);
    if (p.length >= 9) {
      blocked.add(p);
      saveBlocked();
    }
    res.redirect(backTo(req, p));
  });
  app.post('/admin/unblock', (req, res) => {
    if (!gate(req, res)) return;
    const p = norm(req.body?.p);
    blocked.delete(p);
    saveBlocked();
    res.redirect(backTo(req, p));
  });
  app.post('/admin/pool-remove', (req, res) => {
    if (!gate(req, res)) return;
    removeByTail(String(req.body?.t || '').slice(-4));
    res.redirect('/admin/settings');
  });
}
