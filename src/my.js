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
import { historyFor } from './admin.js';

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
const me = (req) => {
  const s = sess[cookieOf(req, 'my')];
  return s && s.until > Date.now() ? s.phone : '';
};

// הגבלת ניסיונות כניסה כללית
let fails = [];

export function addMyRoutes(app) {
  app.use('/my', (req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    next();
  });

  app.get('/my', (req, res) => {
    const phone = me(req);
    if (!phone) {
      const e = { wrong: 'הקוד שגוי', expired: 'הקוד פג תוקף או שנוסה יותר מדי פעמים. בקשו קוד חדש בקו', many: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' }[req.query.e] || '';
      return res.send(shell('האיזור האישי', `<div class="card" style="max-width:420px"><h1>האיזור האישי בקו</h1>
<p>כדי להיכנס, התקשרו לקו, היכנסו לאיזור האישי (מקש 4) והקישו 7. הקו יקריא לכם קוד כניסה.</p>${e ? `<p style="color:#c62828">${e}</p>` : ''}
<form method="post" action="/my/login"><p><input name="phone" inputmode="tel" placeholder="מספר הטלפון שממנו התקשרתם" style="width:100%" required></p>
<p><input name="code" inputmode="numeric" maxlength="6" placeholder="קוד בן 6 ספרות" style="width:100%" required autocomplete="one-time-code"></p><button>כניסה</button></form></div>`));
    }
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
<form method="post" action="/my/logout"><button class="gray">יציאה</button></form></div>
<div class="card"><h2>המייל שלי</h2>${mailCard}<p class="note">הסיסמה נבדקת מול ג׳ימייל ונשמרת מוצפנת בשרת. תוכן המיילים לא נשמר.</p></div>
<div class="card"><h2>חשבונות באתרים</h2>${forums}<p class="note">הסיסמה נבדקת מול האתר ונשמרת מוצפנת בשרת.</p></div>
<div class="card"><h2>מה העוזר זוכר עליי</h2><p>העוזר מתאים את התשובות לפי מה שכתוב כאן. אפשר להוסיף, למשל "קוראים לי משה" או "תענה לי תמיד בקצרה".</p><ul>${prefs || '<li>עדיין כלום</li>'}</ul>
<form method="post" action="/my/pref"><input name="t" maxlength="300" placeholder="משהו שהעוזר צריך לדעת" required style="width:100%"><button>הוסף</button></form></div>
${isDonor(phone) ? '' : `<div class="card"><h2>תומכי הקו</h2><p>מי שתורם מפתח חינמי של Groq מקבל מענה מהיר בעדיפות, שאלות ללא הגבלה, תשובות מורחבות וזיכרון גדול. <a class="btn" href="/donate">להצטרפות</a></p></div>`}
<div class="card"><h2>השיחות שלי</h2><p class="note">בכחול: מה שאמרתם. באפור: מה שהקו ענה.</p>${hist}</div>`));
  });

  app.post('/my/login', (req, res) => {
    fails = fails.filter((t) => Date.now() - t < 10 * 60_000);
    if (fails.length > 30) return res.redirect('/my?e=many');
    const phone = users.normPhone(req.body?.phone);
    const r = phone.length === 9 ? users.checkWebCode(phone, req.body?.code) : 'wrong';
    if (r !== 'ok') {
      fails.push(Date.now());
      return res.redirect(`/my?e=${r}`);
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    sess[sid] = { phone, until: Date.now() + 30 * 86400_000 };
    saveSess();
    res.set('set-cookie', `my=${sid}; HttpOnly; SameSite=Lax; Path=/my; Max-Age=${30 * 86400}`);
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
  app.post('/my/pref/del', (req, res) => {
    const p = need(req, res);
    if (!p) return;
    users.removePref(p, Number(req.body?.i));
    back(res, 'נמחק');
  });
}
