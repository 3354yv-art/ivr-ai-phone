// האיזור האישי באתר: כל מתקשר נכנס עם מספר הטלפון וקוד שהקו מקריא לו.
// שם הוא מחבר מייל וחשבון פורום, רואה ועורך מה העוזר זוכר עליו, ורואה את השיחות שלו.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';
import * as users from './users.js';
import { verifyAccount } from './mail.js';
import { Forum, FORUMS, dropForum } from './nodebb.js';
import { isDonor } from './pool.js';
import { historyFor, roleOf } from './admin.js';
import { VOICES, googleVoiceOn } from './voice.js';
import * as gs from './gscript.js';

const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (k) => (k && k[0] !== '0' ? `0${k}` : k);
const fmt = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

const shell = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:16px;color:#222}.card{background:#fff;border-radius:12px;padding:20px;max-width:720px;margin:0 auto 16px;box-shadow:0 2px 10px #0002}
input{padding:9px;font-size:16px;font-family:inherit;box-sizing:border-box;margin:3px 0}button,.btn{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:9px 18px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
button.red{background:#c62828}button.gray{background:#757575}h1,h2{margin-top:0}.ok{color:#2e7d32}.note{color:#666;font-size:13px}.msg{padding:9px 13px;border-radius:12px;margin:6px 0;max-width:85%;white-space:pre-wrap;line-height:1.5}
.me{background:#e3f2fd;margin-left:auto}.bot{background:#f1f1f1;margin-right:auto}.time{font-size:12px;color:#888}li{margin:6px 0}.flash{background:#e8f0fe;border-radius:8px;padding:10px}</style></head><body>${body}</body></html>`;

// חיבורים לאתר נשמרים בקובץ, כדי שלא יתנתקו כשהשרת עולה מחדש
const sfile = () => path.join(cfg.dataDir, 'web-sessions.json');
let sess = {};
try {
  sess = JSON.parse(fs.readFileSync(sfile(), 'utf8'));
} catch {
  /* אין */
}
const saveSess = () => {
  const now = Date.now();
  for (const [k, v] of Object.entries(sess)) if (v.until < now) delete sess[k];
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(sfile(), JSON.stringify(sess), { mode: 0o600 });
};
const cookieOf = (req, n) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${n}=([^;]+)`));
  return m ? m[1] : '';
};
// החיבור מתחדש בכל כניסה: מי שנכנס לפחות פעם בשנה לא יתנתק לעולם
const YEAR = 365 * 86400_000;
const me = (req, res) => {
  const sid = cookieOf(req, 'my');
  const s = sess[sid];
  if (!s || s.until < Date.now()) return '';
  if (res && s.until - Date.now() < YEAR - 86400_000) {
    s.until = Date.now() + YEAR;
    saveSess();
    res.append('set-cookie', `my=${sid}; HttpOnly; SameSite=Lax; Path=/my; Max-Age=${YEAR / 1000}`);
  }
  return s.phone;
};

export function openMySession(phone) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sess[sid] = { phone: users.normPhone(phone), until: Date.now() + YEAR };
  saveSess();
  return `my=${sid}; HttpOnly; SameSite=Lax; Path=/my; Max-Age=${YEAR / 1000}`;
}

// הגבלת ניסיונות כניסה כללית
let fails = [];

export function addMyRoutes(app) {
  app.use('/my', (req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    next();
  });

  app.get('/my', (req, res) => {
    const phone = me(req, res);
    if (!phone) return res.redirect('/');
    const u = users.getUser(phone) || {};
    const flash = req.query.m ? `<p class="flash">${esc(req.query.m)}</p>` : '';
    const mailCard = u.app || u.google
      ? `<p class="ok">המייל מחובר${u.email ? `: <b dir="ltr">${esc(u.email)}</b>` : ''}. בקו מקישים 3 כדי לשמוע הודעות ולענות.</p><form method="post" action="/my/mail/off"><button class="red">נתק את המייל</button></form>`
      : `<p>חברו ג׳ימייל כדי לשמוע הודעות ולענות להן בטלפון. צריך כתובת ג׳ימייל וסיסמת אפליקציה (16 אותיות): בחשבון גוגל נכנסים ל"אבטחה", ואז "סיסמאות אפליקציה". <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">לחצו כאן ליצירת סיסמת אפליקציה</a>.</p>
<form method="post" action="/my/mail"><input name="email" type="email" dir="ltr" placeholder="name@gmail.com" required style="width:100%"><input name="pass" type="password" dir="ltr" placeholder="סיסמת אפליקציה" autocomplete="off" required style="width:100%"><button>חבר מייל</button></form>`;
    const acc = users.siteAccounts(phone);
    const forums = Object.entries(FORUMS).map(([host, name]) => {
      const a = acc.find((x) => x.host === host);
      return a
        ? `<p class="ok">${esc(name)}: מחובר בתור <b>${esc(a.username)}</b>.</p><form method="post" action="/my/forum/off"><input type="hidden" name="host" value="${esc(host)}"><button class="red">נתק</button></form>`
        : `<p>${esc(name)}: חברו את החשבון כדי שהעוזר יוכל לקרוא בשבילכם, לכתוב תגובות ולקרוא צ׳אטים.</p><form method="post" action="/my/forum"><input type="hidden" name="host" value="${esc(host)}"><input name="u" placeholder="שם משתמש או מייל" autocomplete="off" required style="width:100%"><input name="pw" type="password" placeholder="סיסמה" autocomplete="new-password" required style="width:100%"><button>חבר</button></form>`;
    }).join('');
    const prefs = (u.prefs || []).map((p, i) => `<li>${esc(p)} <form method="post" action="/my/pref/del" style="display:inline"><input type="hidden" name="i" value="${i}"><button class="gray" style="padding:2px 10px;font-size:13px">מחק</button></form></li>`).join('');
    const hist = historyFor(phone, 60).map((r) => `<div class="msg ${r.a ? 'bot' : 'me'}"><div class="time">${fmt(r.t)}</div>${esc(r.a || r.q)}</div>`).join('') || '<p>עדיין אין שיחות.</p>';
    res.send(shell('האיזור האישי', `<div class="card"><h1>שלום, <span dir="ltr">${esc(show(phone))}</span></h1>${isDonor(phone) ? '<p class="ok">אתם מתומכי הקו. תודה!</p>' : ''}${flash}
${roleOf(phone) ? `<p><a href="/${roleOf(phone) === 'owner' ? 'admin' : 'staff'}">חזרה לניהול</a></p>` : ''}<form method="post" action="/my/logout"><button class="gray">יציאה</button></form></div>
${(() => {
      const g = users.getGScript(phone);
      if (g) {
        const pull = g.url.startsWith('pull:');
        const seen = pull ? gs.lastSeen(users.normPhone(phone)) : 0;
        return `<div class="card"><h2>חשבון גוגל</h2><p class="ok">מחובר${g.email ? `: <b dir="ltr">${esc(g.email)}</b>` : ''}. העוזר בקו יכול לקרוא ולענות למיילים, לספר מה יש ביומן ולקבוע אירועים, ולחפש קבצים ומסמכים בדרייב.</p>${pull ? `<p class="note">${seen ? `הסנכרון האחרון עם גוגל: ${fmt(seen)}` : 'מחכה לסנכרון הראשון (עד דקה)'}</p>` : ''}<form method="post" action="/my/gscript/off"><button class="red">נתק</button></form></div>`;
      }
      const code = users.gsLinkCode(phone);
      const secret = users.gsSecret(phone, gs.newSecret);
      const manual = `<p><button type="button" onclick="var t=document.getElementById('gscode');t.select();navigator.clipboard&&navigator.clipboard.writeText(t.value);this.textContent='✓ הקוד הועתק';window.open('https://script.google.com/home/projects/create','_blank')">העתק קוד ופתח את גוגל</button></p>
<p>בדף שנפתח: Ctrl+A ואז Ctrl+V בתוך הקוד. אחר כך <b>Deploy</b> ← <b>New deployment</b> ← <b>Web app</b>, ב-Who has access בוחרים <b>Anyone</b>, <b>Deploy</b>, מאשרים, ולוחצים על הקישור שמופיע.</p>
<textarea id="gscode" readonly dir="ltr" style="width:100%;height:50px;font-family:monospace;font-size:11px;opacity:.6">${esc(gs.scriptCode(secret))}</textarea>
<form method="post" action="/my/gscript"><input name="url" dir="ltr" placeholder="https://script.google.com/macros/s/.../exec" style="width:100%"><button>חבר לפי כתובת</button></form>`;
      if (cfg.gsWebApp) return `<div class="card" id="gcard"><h2>חיבור חשבון גוגל (מייל, יומן, דרייב)</h2>
<p style="font-size:19px"><a href="${cfg.gsWebApp}?phone=${encodeURIComponent(users.normPhone(phone))}&code=${encodeURIComponent(code)}" target="_blank"><b>לחצו כאן להתחברות</b></a>, ואשרו לגוגל את הגישה כשהיא מבקשת.</p>
<p class="note">באישור, גוגל מזהירה שהאפליקציה לא מאומתת. זה רגיל: לוחצים <b>Advanced</b> (מתקדם) ← <b>Go to</b> (מעבר אל) ← <b>Allow</b> (אישור). הקוד רץ רק בחשבון שלכם, ובדף שנפתח תופיע הודעה קצרה שהחיבור הצליח.</p>
<p class="note">הדף הזה יתעדכן לבד כשהחיבור יצליח.</p>
<details><summary class="note">דרך אחרת (למתקדמים)</summary>${manual}</details></div>
<script>setInterval(function(){fetch('/my/gs-status').then(function(r){return r.text()}).then(function(t){if(t==='1')location.reload()})},4000)</script>`;
      if (!cfg.gsTemplate) return `<div class="card" id="gcard"><h2>חיבור חשבון גוגל (מייל, יומן, דרייב)</h2>${manual}</div><script>setInterval(function(){fetch('/my/gs-status').then(function(r){return r.text()}).then(function(t){if(t==='1')location.reload()})},4000)</script>`;
      return `<div class="card" id="gcard"><h2>חיבור חשבון גוגל (מייל, יומן, דרייב)</h2>
<p style="font-size:19px"><b>1.</b> <a href="https://docs.google.com/spreadsheets/d/${cfg.gsTemplate}/copy" target="_blank"><b>לחצו כאן</b></a>, ואז על הכפתור <b>Make a copy</b> (יצירת עותק).</p>
<p style="font-size:19px"><b>2.</b> בקובץ שנפתח, ממלאים בתאים הצהובים את מספר הטלפון <b dir="ltr">${esc(show(phone))}</b> ואת קוד החיבור: <b dir="ltr" style="font-size:24px;letter-spacing:3px">${esc(code)}</b></p>
<p style="font-size:19px"><b>3.</b> בתפריט למעלה לוחצים <b>📞 חיבור לקו</b> ← <b>התחברות</b>, ומאשרים לגוגל.</p>
<p class="note">באישור, גוגל מזהירה שהאפליקציה לא מאומתת. זה רגיל: לוחצים <b>Advanced</b> (מתקדם) ← <b>Go to</b> (מעבר אל) ← <b>Allow</b> (אישור). הקוד רץ רק בחשבון שלכם. אם אחרי האישור לא קרה כלום, לוחצים שוב על התחברות.</p>
<p class="note">הדף הזה יתעדכן לבד כשהחיבור יצליח.</p>
<details><summary class="note">דרך אחרת (למתקדמים)</summary>${manual}</details></div>
<script>setInterval(function(){fetch('/my/gs-status').then(function(r){return r.text()}).then(function(t){if(t==='1')location.reload()})},4000)</script>`;
    })()}
<div class="card"><h2>המייל שלי</h2>${mailCard}<p class="note">הסיסמה נבדקת מול ג׳ימייל ונשמרת מוצפנת בשרת. תוכן המיילים לא נשמר.</p></div>
<div class="card"><h2>חשבונות באתרים</h2>${forums}<p class="note">הסיסמה נבדקת מול האתר ונשמרת מוצפנת בשרת.</p></div>
<div class="card"><h2>מה העוזר זוכר עליי</h2><p>העוזר מתאים את התשובות לפי מה שכתוב כאן. אפשר להוסיף, למשל "קוראים לי משה" או "תענה לי תמיד בקצרה".</p><ul>${prefs || '<li>עדיין כלום</li>'}</ul>
<form method="post" action="/my/pref"><input name="t" maxlength="300" placeholder="משהו שהעוזר צריך לדעת" required style="width:100%"><button>הוסף</button></form></div>
<div class="card"><h2>שם משתמש</h2><p>${users.usernameOf(phone) ? `שם המשתמש שלכם: <b>${esc(users.usernameOf(phone))}</b>` : 'עדיין אין שם משתמש. בחרו שם, ותוכלו להיכנס איתו במקום מספר הטלפון.'}</p>
<form method="post" action="/my/username"><input name="user" maxlength="30" placeholder="שם משתמש" required style="width:100%"><button>שמור</button></form></div>
<div class="card"><h2>סיסמה קבועה לאתר</h2><p>${users.hasWebPassword(phone) ? 'יש לכם סיסמה קבועה. אפשר להחליף אותה כאן.' : 'בחרו סיסמה, ואז תוכלו להיכנס בכל מחשב עם מספר הטלפון והסיסמה, בלי קוד מהקו.'}</p>
<form method="post" action="/my/password"><input name="pw" type="password" minlength="6" autocomplete="new-password" placeholder="סיסמה חדשה (לפחות 6 תווים)" required style="width:100%"><input name="pw2" type="password" minlength="6" autocomplete="new-password" placeholder="שוב את אותה סיסמה" required style="width:100%"><button>שמור סיסמה</button></form>
${users.hasWebPassword(phone) ? '<form method="post" action="/my/password/off"><button class="gray">בטל סיסמה קבועה</button></form>' : ''}</div>
<div class="card"><h2>הגדרות</h2><form method="post" action="/my/settings">
${googleVoiceOn() ? `<p>קול העוזר: <select name="voice">${VOICES.map((x) => `<option value="${x.id}" ${((u.settings || {}).voice || '') === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></p>
<p>מהירות דיבור: <select name="speed">${[['slow', 'איטי'], ['normal', 'רגיל'], ['fast', 'מהיר']].map(([k, n]) => `<option value="${k}" ${((u.settings || {}).speed || 'normal') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></p>` : '<p class="note">בחירת קולות תופעל כשהמנהל יגדיר מפתח של גוגל קלאוד.</p>'}
<p><label><input type="checkbox" name="alwaysSearch" value="1" ${(u.settings || {}).alwaysSearch !== false ? 'checked' : ''}> העוזר יחפש ברשת בכל שאלה (מדויק יותר, קצת יותר איטי)</label></p>
<p>אורך התשובות: <select name="length">${[['short', 'קצרות'], ['medium', 'בינוניות'], ['long', 'מפורטות']].map(([k, n]) => `<option value="${k}" ${((u.settings || {}).length || 'medium') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></p><button>שמור הגדרות</button></form></div>
<div class="card"><h2>קיצורי אתרים</h2><p>שם קצר לאתר שאתם נכנסים אליו הרבה. בקו: חיפוש ואתרים, ואז 4. או פשוט אומרים את השם בכניסה לאתר.</p><ul>${(u.shortcuts || []).map((s, i) => `<li><b>${esc(s.name)}</b>: <span dir="ltr">${esc(s.url)}</span> <form method="post" action="/my/shortcut/del" style="display:inline"><input type="hidden" name="i" value="${i}"><button class="gray" style="padding:2px 10px;font-size:13px">מחק</button></form></li>`).join('') || '<li>אין עדיין</li>'}</ul>
<form method="post" action="/my/shortcut"><input name="name" placeholder="שם הקיצור, למשל: חדשות" required maxlength="60" style="width:100%"><input name="url" dir="ltr" placeholder="https://..." required style="width:100%"><button>הוסף קיצור</button></form></div>
${isDonor(phone) ? '' : `<div class="card"><h2>תומכי הקו</h2><p>מי שתורם מפתח חינמי של Groq מקבל מענה מהיר בעדיפות, שאלות ללא הגבלה, תשובות מורחבות וזיכרון גדול. <a class="btn" href="/donate">להצטרפות</a></p></div>`}
<div class="card"><h2>השיחות שלי</h2><p class="note">בכחול: מה שאמרתם. באפור: מה שהקו ענה.</p>${hist}</div>`));
  });

  app.post('/my/login', (req, res) => {
    fails = fails.filter((t) => Date.now() - t < 10 * 60_000);
    if (fails.length > 30) return res.redirect('/my?e=many');
    const phone = users.normPhone(req.body?.phone);
    let r = phone.length === 9 ? users.checkWebCode(phone, req.body?.code) : 'wrong';
    if (r !== 'ok' && phone.length === 9 && users.checkWebPassword(phone, req.body?.code)) r = 'ok';
    if (r !== 'ok') {
      fails.push(Date.now());
      return res.redirect(`/my?e=${r}`);
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    sess[sid] = { phone, until: Date.now() + YEAR };
    saveSess();
    res.set('set-cookie', `my=${sid}; HttpOnly; SameSite=Lax; Path=/my; Max-Age=${YEAR / 1000}`);
    res.redirect('/my?m=' + encodeURIComponent('נכנסתם בהצלחה'));
  });

  // כל הפעולות דורשות כניסה
  const need = (req, res) => {
    const p = me(req);
    if (!p) res.redirect('/my');
    return p;
  };
  const back = (res, m) => res.redirect('/my?m=' + encodeURIComponent(m));

  app.post('/my/logout', (req, res) => {
    delete sess[cookieOf(req, 'my')];
    saveSess();
    res.set('set-cookie', 'my=; HttpOnly; SameSite=Lax; Path=/my; Max-Age=0');
    res.redirect('/my');
  });
  app.post('/my/mail', async (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const pass = String(req.body?.pass || '').replace(/\s/g, '').toLowerCase();
    if (!/^[^\s@]+@(gmail|googlemail)\.com$/.test(email)) return back(res, 'צריך כתובת ג׳ימייל');
    if (!/^[a-z]{16}$/.test(pass)) return back(res, 'סיסמת אפליקציה היא 16 אותיות באנגלית');
    if (!(await verifyAccount(email, pass))) return back(res, 'ג׳ימייל לא קיבל את הפרטים. בדקו את הכתובת והסיסמה');
    users.setAppPassword(p, email, pass);
    back(res, 'המייל חובר. בקו מקישים 3 כדי לשמוע הודעות');
  });
  app.post('/my/gscript', async (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const url = String(req.body?.url || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return back(res, 'הכתובת צריכה להיות כתובת Web app של הסקריפט, שמסתיימת ב-exec');
    try {
      const email = await gs.call(url, users.gsSecret(p), 'ping');
      users.setGScript(p, url, email);
      back(res, 'חשבון גוגל חובר בהצלחה');
    } catch (e) {
      back(res, `החיבור נכשל: ${String(e.message).slice(0, 140)}`);
    }
  });
  app.get('/my/gs-status', (req, res) => {
    const p = me(req);
    res.set('cache-control', 'no-store').send(p && users.getGScript(p) ? '1' : '0');
  });
  app.post('/my/gscript/off', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.removeGScript(p);
    back(res, 'חשבון גוגל נותק');
  });
  app.post('/my/mail/off', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.disconnectMail(p);
    back(res, 'המייל נותק');
  });
  app.post('/my/forum', async (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const host = String(req.body?.host || '');
    if (!FORUMS[host]) return back(res, 'אתר לא מוכר');
    try {
      const who = await new Forum(host).login(String(req.body?.u || '').trim(), String(req.body?.pw || ''));
      users.setSiteAccount(p, host, String(req.body.u).trim(), String(req.body.pw));
      dropForum(p, host);
      back(res, `החשבון ב${FORUMS[host]} חובר בתור ${who.username || req.body.u}`);
    } catch (e) {
      back(res, `החיבור נכשל: ${String(e.message).slice(0, 120)}`);
    }
  });
  app.post('/my/forum/off', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.removeSiteAccount(p, String(req.body?.host || ''));
    dropForum(p, String(req.body?.host || ''));
    back(res, 'החשבון נותק');
  });
  app.post('/my/pref', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.addPref(p, req.body?.t);
    back(res, 'נשמר');
  });
  app.post('/my/username', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const r = users.setUsername(p, req.body?.user);
    back(res, { ok: 'שם המשתמש נשמר', taken: 'השם תפוס, בחרו שם אחר', invalid: 'שם משתמש צריך להיות 2 עד 30 תווים, ולא רק ספרות' }[r]);
  });
  app.post('/my/password', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const a = String(req.body?.pw || '');
    if (a !== String(req.body?.pw2 || '')) return back(res, 'הסיסמאות לא זהות');
    if (a.length < 6) return back(res, 'הסיסמה צריכה להיות לפחות 6 תווים');
    users.setWebPassword(p, a);
    back(res, 'הסיסמה נשמרה. מעכשיו אפשר להיכנס עם מספר הטלפון והסיסמה');
  });
  app.post('/my/password/off', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.clearWebPassword(p);
    back(res, 'הסיסמה הקבועה בוטלה');
  });
  app.post('/my/settings', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    const b = req.body || {};
    if (VOICES.some((x) => x.id === b.voice)) users.setSetting(p, 'voice', b.voice);
    if (['slow', 'normal', 'fast'].includes(b.speed)) users.setSetting(p, 'speed', b.speed);
    if (['short', 'medium', 'long'].includes(b.length)) users.setSetting(p, 'length', b.length);
    users.setSetting(p, 'alwaysSearch', b.alwaysSearch === '1');
    back(res, 'ההגדרות נשמרו');
  });
  app.post('/my/shortcut', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    let url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      return back(res, 'כתובת לא תקינה');
    }
    users.addShortcut(p, String(req.body?.name || '').trim(), url);
    back(res, 'הקיצור נשמר');
  });
  app.post('/my/shortcut/del', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.removeShortcut(p, Number(req.body?.i));
    back(res, 'נמחק');
  });
  app.post('/my/pref/del', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.removePref(p, Number(req.body?.i));
    back(res, 'נמחק');
  });
}
