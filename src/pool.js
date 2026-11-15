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
export const poolList = () => pool.map((p) => ({ tail: p.key.slice(-4), t: p.t, phone: p.phone || '' }));
const np = (x) => String(x || '').replace(/\D/g, '').replace(/^972/, '0').replace(/^0?/, '0');
// תומכי הקו: מי שתרם מפתח וקישר אותו למספר הטלפון שלו
export const isDonor = (phone) => !!phone && pool.some((p) => p.phone && p.phone === np(phone));
export const donorKey = (phone) => (phone ? pool.find((p) => p.phone && p.phone === np(phone))?.key : undefined);
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
const PERKS = '<ul><li><b>מהירות בעדיפות:</b> המפתח שלך משמש קודם כל אותך, כך שאתה לא מחכה בתור גם כשהקו עמוס</li><li><b>שאלות ללא הגבלה</b> ביום</li><li><b>תשובות מורחבות</b> ומפורטות יותר</li><li><b>זיכרון גדול:</b> העוזר זוכר עליך עד 50 דברים (במקום 15) ואת כל השיחה</li><li>ברכה אישית בכל כניסה לקו</li></ul>';

export function addPoolRoutes(app) {
  app.get('/donate', (req, res) => {
    const warn = secure(req) ? '' : '<p style="color:#b26a00;font-size:14px">שימו לב: החיבור לדף הזה עדיין לא מוצפן. מומלץ ליצור ב-Groq מפתח נפרד רק בשביל הקו, כך שאפשר למחוק אותו שם בכל רגע.</p>';
    res.send(page(`<h2>הצטרפו לתומכי הקו</h2>
<p>הקו פועל בזכות מפתחות חינמיים של Groq. מי שתורם מפתח עוזר לקו להישאר מהיר לכולם, ומקבל הטבות של תומך:</p>${PERKS}
<p><b>איך משיגים מפתח (חינם, דקה):</b> נכנסים ל-console.groq.com, מתחברים, בוחרים API Keys ולוחצים Create API Key. מעתיקים את המפתח (מתחיל ב-gsk_) ומדביקים כאן.</p>
<p><b>שימו לב:</b> השימוש במפתח נספר על החשבון שלכם ב-Groq, במסגרת החינמית שלו. המפתח נשמר בשרת בלבד ולא מוצג לאף אחד. אפשר לבקש את הסרתו בכל עת.</p>${warn}
<form method="post" action="/donate">
<p><input name="k" type="password" autocomplete="off" placeholder="gsk_..." style="width:100%;padding:10px;font-size:16px"></p>
<p><input name="phone" inputmode="tel" placeholder="מספר הטלפון שממנו אתם מתקשרים לקו (בשביל ההטבות)" style="width:100%;padding:10px;font-size:16px"></p>
<p><label><input type="checkbox" name="ok" value="1"> אני מבין ומסכים שהקו ישתמש במפתח שלי</label></p><button>הצטרף לתומכים</button></form>`));
  });
  app.post('/donate', async (req, res) => {
    const k = String(req.body?.k || '').trim();
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (req.body?.ok !== '1') return res.status(400).send(page('<p>צריך לאשר את ההסכמה. חזרו אחורה ונסו שוב.</p>'));
    if (!/^gsk_[A-Za-z0-9]{20,100}$/.test(k)) return res.status(400).send(page('<p>המפתח לא נראה תקין. הוא צריך להתחיל ב-gsk_</p>'));
    if (phone && !/^0?\d{8,9}$|^972\d{8,9}$/.test(phone)) return res.status(400).send(page('<p>מספר הטלפון לא תקין.</p>'));
    const existing = pool.find((p) => p.key === k);
    if (existing) {
      if (phone) { existing.phone = np(phone); save(); }
      return res.send(page('<p>המפתח כבר קיים. תודה!' + (phone ? ' עדכנו את מספר הטלפון להטבות.' : '') + '</p>'));
    }
    if (allKeys().includes(k)) return res.send(page('<p>המפתח כבר קיים. תודה!</p>'));
    if (!(await valid(k))) return res.status(400).send(page('<p>המפתח לא עובד מול Groq. בדקו שהעתקתם אותו במלואו.</p>'));
    pool.push({ key: k, t: Date.now(), ...(phone ? { phone: np(phone) } : {}) });
    save();
    res.send(page(`<h2>תודה רבה!</h2><p>המפתח נקלט (מסתיים ב-${esc(k.slice(-4))}).</p>${phone ? `<p>מעכשיו המספר ${esc(np(phone))} מקבל את הטבות התומכים:</p>${PERKS}` : '<p>לא הזנתם מספר טלפון, ולכן אין הטבות אישיות. אפשר לחזור לדף ולהזין את אותו מפתח עם המספר.</p>'}`));
  });
}
