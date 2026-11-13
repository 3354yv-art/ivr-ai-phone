import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { YemotRouter, CallError } from 'yemot-router2';
import { cfg } from './config.js';
import { clean, chunk } from './tts.js';
import * as ai from './ai.js';
import { warmUp as llmWarm } from './llm.js';
import { downloadRecording, deleteRecording, tokenFor } from './yemot.js';
import { fetchPage } from './web.js';
import * as mail from './mail.js';
import * as gmail from './gmail.js';
import * as users from './users.js';
import { sendLoginEmail } from './notify.js';
import { addPoolRoutes, allKeys } from './pool.js';
import { addAdminRoutes, isBlocked, logQuery, recentFor } from './admin.js';

const T = (data) => ({ type: 'text', data: clean(data) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// שגיאות "בקרה" של הספרייה (ניתוק, יציאה) חייבות לעבור הלאה ולא להיבלע
const isControl = (e) => e instanceof CallError;

// ---------- כלי עזר לשיחה ----------

// שואל שאלה עם הקשה אחת
function ask(call, text, allowed, opts = {}) {
  return call.read([T(text)], 'tap', {
    max_digits: 1,
    min_digits: 1,
    sec_wait: 7,
    digits_allowed: allowed,
    ...opts,
  });
}

// ממתין לפעולה ארוכה (ג'מיני, אתר) ומשמיע מוזיקה. ימות לא מחכה יותר מכמה שניות לתשובה,
// לכן כל שנייה-שתיים חוזרים אליה עם הודעת המתנה קצרה עד שהפעולה מסתיימת.
async function waitFor(call, promise, maxMs = 90000) {
  let state = 'pending';
  let value;
  let error;
  promise.then(
    (v) => ((state = 'ok'), (value = v)),
    (e) => ((state = 'err'), (error = e)),
  );
  await Promise.race([promise.catch(() => {}), sleep(allKeys().length || cfg.cerebrasKey || cfg.cfToken ? 2000 : 300)]);
  const started = Date.now();
  let first = true;
  while (state === 'pending') {
    if (Date.now() - started > maxMs) throw new Error('הפעולה לקחה יותר מדי זמן');
    await call.read(
      first ? [T('אנא המתן')] : [{ type: 'music_on_hold', data: { musicName: cfg.music, maxSec: 3 } }],
      'tap',
      { max_digits: 1, min_digits: 1, sec_wait: 1, allow_empty: true, empty_val: 'None', digits_allowed: [] },
    );
    first = false;
    await Promise.race([promise.catch(() => {}), sleep(100)]);
  }
  if (state === 'err') throw error;
  return value;
}

// מקליט את המחייג ומתמלל. מחזיר טקסט (ריק אם לא נשמע דבר)
async function listen(call, prompt, maxLen = 25, kind = 'דיבור') {
  const txt = await listenRaw(call, prompt, maxLen);
  if (kind) logQuery(call.phone, kind, txt);
  return txt;
}

async function listenRaw(call, prompt, maxLen = 25) {
  // זיהוי דיבור של ימות עצמה: בלי הורדת הקלטה ובלי תמלול נוסף. אם לא הובן, חוזרים להקלטה
  if (cfg.yemotStt && !cfg.mock) {
    try {
      const t = await call.read([T(prompt)], 'stt', { lang: 'iw-IL', max_length: maxLen, quiet_max: 2, use_records_recognition_engine: true, block_typing: undefined, allow_empty: true });
      const txt = String(t ?? '').trim();
      if (txt && txt !== 'None') return txt;
      prompt = 'לא הבנתי, אמור שוב';
    } catch (e) {
      // שגיאת הגדרה (לא ניתוק שיחה): ממשיכים להקלטה רגילה
      if (isControl(e) && !/option|mode|invalid/i.test(String(e.message))) throw e;
      console.warn('stt של ימות נכשל:', e.message);
    }
  }
  const path = await call.read([T(prompt)], 'record', {
    no_confirm_menu: true,
    min_length: 1,
    max_length: maxLen,
    file_name: `q${Date.now() % 100000000}`,
  });
  if (!path || path === 'None') return '';
  const token = tokenFor(call);
  const job = (async () => {
    const wav = await downloadRecording(path, token);
    deleteRecording(path, token);
    return ai.transcribe(wav);
  })();
  return (await waitFor(call, job)).trim();
}

// מקריא טקסט בקטעים. 0 = עצירה, 4 = אחורה, 6 = דילוג
async function speak(call, text) {
  const parts = chunk(text);
  if (!parts.length) {
    await call.read([T('אין מה להקריא')], 'tap', { max_digits: 1, sec_wait: 1, allow_empty: true, empty_val: 'None', digits_allowed: [] });
    return 'done';
  }
  let i = 0;
  while (i < parts.length) {
    const k = await call.read([{ type: 'text', data: parts[i] }], 'tap', {
      max_digits: 1,
      min_digits: 1,
      sec_wait: 1,
      allow_empty: true,
      empty_val: 'None',
      digits_allowed: [0, 4, 6],
    });
    if (k === '0') return 'stop';
    if (k === '4') i = Math.max(0, i - 1);
    else i += 1;
  }
  return 'done';
}

// ---------- שלוחה 1: צ'אט ----------
async function chatMode(call) {
  const history = [];
  let q = await listen(call, 'מה תרצה לשאול', 25, 'שיחה עם AI');
  while (true) {
    if (!q) {
      q = await listen(call, 'לא שמעתי, אפשר לשאול שוב');
      if (!q) return;
      continue;
    }
    const answer = await waitFor(call, ai.chat(history, q));
    history.push({ role: 'user', text: q }, { role: 'model', text: answer });
    if (history.length > 20) history.splice(0, 2);
    let again = true;
    while (again) {
      await speak(call, answer);
      const c = await ask(call, 'לשאלה נוספת הקש 1, לשמיעה חוזרת הקש 2, לתפריט הראשי הקש 0', [0, 1, 2], { sec_wait: 6, allow_empty: true, empty_val: '1' });
      if (c === '2') continue;
      if (c === '0') return;
      again = false;
    }
    q = await listen(call, 'מה תרצה לשאול', 25, 'שיחה עם AI');
  }
}

// ---------- דפדוף באתר ----------
async function browse(call, startUrl) {
  const stack = [];
  let url = startUrl;
  while (url) {
    let page;
    try {
      page = await waitFor(call, fetchPage(url));
    } catch (e) {
      if (isControl(e)) throw e;
      console.error('fetchPage', url, e.message);
      await speak(call, 'לא הצלחתי לפתוח את האתר');
      url = stack.pop() ?? null;
      continue;
    }
    await speak(call, `נפתח הדף ${page.title}`);
    let reading = true;
    let next = null;
    while (reading) {
      const r = await speak(call, page.text);
      if (r === 'done') {
        await speak(call, 'סוף הדף');
      }
      // תפריט דף
      const c = await ask(call, 'לסיכום הדף הקש 1, לקריאה מחדש 2, לקישורים בדף 3, לדבר עם הסוכן הקש 5, לחזרה אחורה 0', [0, 1, 2, 3, 5], { sec_wait: 8, allow_empty: true, empty_val: '0' });
      if (c === '1') {
        const s = await waitFor(call, ai.summarize(page.text));
        await speak(call, s);
      } else if (c === '3') {
        if (!page.links.length) {
          await speak(call, 'לא נמצאו קישורים בדף');
        } else {
          const list = page.links.map((l, i) => `${i + 1}, ${l.text}`).join(', ');
          const n = await ask(call, `הקש את מספר הקישור שתרצה לפתוח. ${list}`, page.links.map((_, i) => i + 1), { sec_wait: 10, allow_empty: true, empty_val: '0' });
          const link = page.links[Number(n) - 1];
          if (link) {
            stack.push(url);
            next = link.url;
            reading = false;
          }
        }
      } else if (c === '5') {
        const cmd = await listen(call, 'אמור לסוכן מה לעשות בדף', 25, 'פקודה לסוכן');
        if (!cmd) {
          await speak(call, 'לא שמעתי');
        } else {
          const act = await waitFor(call, ai.agent(page, cmd));
          if (act.action === 'open') {
            await speak(call, `נכנס ל${act.title}`);
            stack.push(url);
            next = act.url;
            reading = false;
          } else if (act.action === 'back') {
            reading = false;
          } else if (act.action === 'summary') {
            await speak(call, await waitFor(call, ai.summarize(page.text)));
          } else if (act.action === 'answer') {
            await speak(call, act.text || 'אין לי תשובה');
          } else if (act.action === 'read') {
            continue;
          } else {
            await speak(call, 'לא הצלחתי להבין או לבצע את הבקשה');
          }
        }
      } else if (c === '0') {
        reading = false;
      }
      // c === '2' - קוראים שוב
    }
    url = next ?? (stack.length && !next ? stack.pop() : null);
    if (!next && !url) break;
  }
}

// ---------- שלוחה 3: חיפוש ----------
async function searchMode(call) {
  while (true) {
    const q = await listen(call, 'מה לחפש בגוגל', 25, 'חיפוש');
    if (!q) {
      const c = await ask(call, 'לא שמעתי. לנסות שוב הקש 1, לתפריט הראשי הקש 0', [0, 1], { allow_empty: true, empty_val: '0' });
      if (c === '1') continue;
      return;
    }
    const res = await waitFor(call, ai.search(q));
    let more = true;
    while (more) {
      await speak(call, res.answer);
      const opts = res.sources.length
        ? 'לשמיעת האתרים שנמצאו הקש 1, לשמיעה חוזרת הקש 2, לחיפוש חדש הקש 3, לתפריט הראשי הקש 0'
        : 'לשמיעה חוזרת הקש 2, לחיפוש חדש הקש 3, לתפריט הראשי הקש 0';
      const c = await ask(call, opts, [0, 1, 2, 3], { sec_wait: 8, allow_empty: true, empty_val: '3' });
      if (c === '0') return;
      if (c === '3') more = false;
      else if (c === '1' && res.sources.length) {
        const list = res.sources.map((s, i) => `אתר ${i + 1}, ${s.title}`).join(', ');
        const n = await ask(call, `${list}. הקש את מספר האתר לכניסה, או אפס לחזרה`, [0, ...res.sources.map((_, i) => i + 1)], { sec_wait: 12, allow_empty: true, empty_val: '0' });
        const s = res.sources[Number(n) - 1];
        if (s) await browse(call, s.url);
      }
    }
  }
}

// ---------- שלוחה 4: כניסה לאתר לפי שם ----------
async function siteMode(call) {
  while (true) {
    const name = await listen(call, 'אמור את שם האתר', 25, 'כניסה לאתר');
    if (!name) {
      const c = await ask(call, 'לא שמעתי. לנסות שוב הקש 1, לתפריט הראשי הקש 0', [0, 1], { allow_empty: true, empty_val: '0' });
      if (c === '1') continue;
      return;
    }
    const url = await waitFor(call, ai.findSite(name));
    if (!url) {
      await speak(call, 'לא מצאתי את האתר');
      continue;
    }
    await browse(call, url);
    const c = await ask(call, 'לכניסה לאתר אחר הקש 1, לתפריט הראשי הקש 0', [0, 1], { allow_empty: true, empty_val: '0' });
    if (c !== '1') return;
  }
}

// ---------- שלוחה 2: מייל ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ספק המייל של המתקשר: ג'ימייל שחובר דרך הקישור, או תיבת השרת אם זה המייל של בעל המערכת
function providerFor(call) {
  const u = users.getUser(call.phone);
  if (u?.google?.refresh) return gmail.provider(u.google.refresh);
  if (u?.email && cfg.mailUser && u.email === cfg.mailUser.toLowerCase() && mail.mailEnabled()) return mail;
  return null;
}

// מקריא כתובת מייל תו אחר תו: אותיות באנגלית, ספרות, ושמות לסימנים
function spellEmail(email) {
  const names = { '@': 'שטרודל', '.': 'נקודה', '-': 'מקף', _: 'קו תחתון', '+': 'פלוס' };
  const out = [];
  for (const run of email.match(/[a-z]+|\d+|./gi) || []) {
    if (/^[a-z]+$/i.test(run)) out.push({ type: 'alpha', data: run.toLowerCase() });
    else if (/^\d+$/.test(run)) out.push({ type: 'digits', data: run });
    else if (names[run]) out.push({ type: 'text', data: names[run] });
  }
  return out;
}

// הרשמה: מקישים מייל בטלפון, מקבלים מייל עם כפתור, והקישור מחבר את הג'ימייל
async function registerFlow(call) {
  if (!call.phone) {
    await speak(call, 'לא ניתן לחבר מייל משיחה ממספר חסוי');
    return;
  }
  await speak(call, 'המייל שלך עדיין לא מחובר. נחבר אותו עכשיו');
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed = await call.read([T('הקש את כתובת המייל שלך באנגלית, ובסיום הקש סולמית')], 'tap', {
      typing_playback_mode: 'EmailKeyboard',
      min_digits: 1,
      sec_wait: 30,
      allow_empty: true,
      empty_val: 'None',
    });
    if (!typed || typed === 'None') return;
    const email = String(typed).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      await speak(call, 'הכתובת לא נראית תקינה');
      continue;
    }
    const c = await call.read([T('הכתובת שהוקשה היא'), ...spellEmail(email), T('לשליחת הקישור הקש 1, להקשה מחדש הקש 2, לביטול הקש 0')], 'tap', {
      max_digits: 1,
      min_digits: 1,
      sec_wait: 10,
      digits_allowed: [0, 1, 2],
      allow_empty: true,
      empty_val: '0',
    });
    if (c === '2') continue;
    if (c !== '1') return;
    let token;
    try {
      token = users.createLoginToken(call.phone, email);
    } catch (e) {
      if (e.code !== 'rate') throw e;
      await speak(call, 'נשלחו יותר מדי בקשות, נסה שוב בעוד שעה');
      return;
    }
    await waitFor(call, sendLoginEmail(email, `${cfg.baseUrl}/connect?t=${token}`));
    await speak(call, 'נשלח אליך מייל עם כפתור. פתח אותו וחבר את הג׳ימייל, ואחר כך חזור לכאן ללא צורך בשום דבר נוסף');
    return;
  }
}

async function mailMode(call) {
  const prov = providerFor(call);
  if (!prov) return registerFlow(call);
  const msgs = await waitFor(call, prov.unread(5));
  if (!msgs.length) {
    await speak(call, 'אין הודעות חדשות');
    return;
  }
  await speak(call, `יש ${msgs.length} הודעות חדשות`);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    let stay = true;
    while (stay) {
      const c = await ask(call, `הודעה ${i + 1} מאת ${m.from}, בנושא ${m.subject}. לשמיעת ההודעה הקש 1, למענה בהקלטה הקש 2, להודעה הבאה הקש 3, לתפריט הראשי הקש 0`, [0, 1, 2, 3], { sec_wait: 8, allow_empty: true, empty_val: '3' });
      if (c === '0') return;
      if (c === '1') {
        await speak(call, m.text || 'ההודעה ריקה');
        prov.markRead(m.uid).catch(() => {});
      } else if (c === '2') {
        await replyFlow(call, prov, m);
      } else {
        stay = false;
      }
    }
  }
  await speak(call, 'אלו היו כל ההודעות החדשות');
}

async function replyFlow(call, prov, m) {
  let body = await listen(call, 'אמור את תוכן התשובה', 60, null);
  while (true) {
    if (!body) {
      await speak(call, 'לא שמעתי דבר, התשובה בוטלה');
      return;
    }
    const c = await ask(call, `התשובה שלך היא: ${body}. לשליחה הקש 1, להקלטה מחדש הקש 2, לביטול הקש 0`, [0, 1, 2], { sec_wait: 10, allow_empty: true, empty_val: '0' });
    if (c === '1') {
      await waitFor(call, prov.sendReply(m, body));
      await speak(call, 'התשובה נשלחה');
      return;
    }
    if (c === '2') {
      body = await listen(call, 'אמור את תוכן התשובה', 60, null);
      continue;
    }
    await speak(call, 'התשובה בוטלה');
    return;
  }
}

// ---------- איזור אישי ----------
async function personalMode(call) {
  while (true) {
    const u = users.getUser(call.phone);
    const state = u?.google?.refresh ? 'הג׳ימייל שלך מחובר' : 'הג׳ימייל שלך עדיין לא מחובר';
    const c = await ask(call, `האיזור האישי. ${state}. לשמיעת החיפושים האחרונים שלך הקש 1, לחיבור הג׳ימייל הקש 2, לתפריט הראשי הקש 0`, [0, 1, 2], { sec_wait: 9, allow_empty: true, empty_val: '0' });
    if (c === '0') return;
    if (c === '1') {
      const mine = recentFor(call.phone, 3);
      await speak(call, mine.length ? mine.map((r, i) => `${i + 1}, ${r.q}`).join('. ') : 'עדיין אין חיפושים');
    } else if (c === '2') {
      await registerFlow(call);
    }
  }
}

// ---------- חיפוש וכניסה לאתרים ----------
async function webMode(call) {
  while (true) {
    const c = await ask(call, 'לחיפוש בגוגל הקש 1, לכניסה לאתר לפי שם הקש 2, לתפריט הראשי הקש 0', [0, 1, 2], { sec_wait: 9, allow_empty: true, empty_val: '0' });
    if (c === '1') await searchMode(call);
    else if (c === '2') await siteMode(call);
    else return;
  }
}

// ---------- התפריט הראשי ----------
function authorized(call) {
  if (cfg.key && call.req.query.key !== cfg.key) return false;
  if (cfg.allowedPhones.length) {
    const p = String(call.phone || '').replace(/\D/g, '');
    const ok = cfg.allowedPhones.some((a) => a.replace(/\D/g, '').slice(-9) === p.slice(-9) && p.length >= 9);
    if (!ok) return false;
  }
  return true;
}

async function handler(call) {
  if (!authorized(call)) {
    console.warn('שיחה לא מורשית מ', call.phone);
    return call.id_list_message([T('אין הרשאה'), { type: 'go_to_folder', data: 'hangup' }]);
  }
  if (isBlocked(call.phone)) {
    return call.id_list_message([T('המספר שלך נחסם'), { type: 'go_to_folder', data: 'hangup' }]);
  }
  console.log('שיחה נכנסת מ', call.phone || 'מספר חסוי');
  await call.id_list_message([T('ברוכים הבאים. שימו לב, שאלות וחיפושים נרשמים לצורך אבטחה')], { prependToNextAction: true });
  while (true) {
    const d = await ask(call, 'לשיחה עם העוזר החכם הקש 1, לחיפוש וגלישה באתרים הקש 2, למייל הקש 3, לאיזור האישי הקש 4, ליציאה הקש 0', [0, 1, 2, 3, 4], { sec_wait: 9 });
    if (d === '0') {
      return call.id_list_message([T('להתראות'), { type: 'go_to_folder', data: 'hangup' }]);
    }
    const fn = { 1: chatMode, 2: webMode, 3: mailMode, 4: personalMode }[d];
    if (!fn) continue;
    try {
      await fn(call);
    } catch (e) {
      if (isControl(e)) throw e;
      console.error(`שגיאה בשלוחה ${d}:`, e);
      await speak(call, e.message === 'BUSY' ? 'כל הקווים עסוקים כרגע, נסה שוב בעוד רגע. חוזרים לתפריט הראשי' : 'אירעה תקלה, חוזרים לתפריט הראשי');
    }
  }
}

// ---------- דפי החיבור (נפתחים מהמייל) ----------
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:32px;max-width:420px;box-shadow:0 2px 14px #0002;text-align:center}
h1{margin-top:0;font-size:24px}p{font-size:17px;line-height:1.6}
.btn{display:inline-block;background:#1a73e8;color:#fff;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:18px;margin-top:10px}</style></head>
<body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;

// ---------- דף הגדרות חד-פעמי: המנהל מדביק מפתחות בדפדפן במקום לערוך קבצים ----------
const SETUP_FIELDS = [
  ['GROQ_API_KEY', 'מפתח Groq (חינמי, מהיר)'],
  ['CEREBRAS_API_KEY', 'מפתח Cerebras (גיבוי, אופציונלי)'],
  ['CLOUDFLARE_ACCOUNT_ID', 'Cloudflare Account ID (גיבוי, אופציונלי)'],
  ['CLOUDFLARE_API_TOKEN', 'Cloudflare API Token (גיבוי, אופציונלי)'],
  ['GEMINI_API_KEY', 'מפתח Gemini (אופציונלי)'],
  ['YEMOT_TOKEN', 'טוקן ימות המשיח (מספר מערכת:סיסמה)'],
  ['MAIL_USER', 'ג׳ימייל לשליחת מיילי החיבור (אופציונלי)'],
  ['MAIL_APP_PASSWORD', 'סיסמת אפליקציה של הג׳ימייל (אופציונלי)'],
  ['BASE_URL', 'כתובת ציבורית של השרת (אופציונלי)'],
  ['GOOGLE_CLIENT_ID', 'Google Client ID (אופציונלי)'],
  ['GOOGLE_CLIENT_SECRET', 'Google Client Secret (אופציונלי)'],
];
const envFile = () => process.env.ENV_FILE || './.env';

function saveEnv(values) {
  const lines = fs.existsSync(envFile()) ? fs.readFileSync(envFile(), 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envFile(), lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n', { mode: 0o600 });
}

function addSetupRoutes(app) {
  const guard = (req, res) => {
    const k = String(req.query.key || req.body?.key || '');
    if (!cfg.key || k !== cfg.key) {
      res.status(403).send(page('אין גישה', '<p>הקישור לא תקין.</p>'));
      return false;
    }
    return true;
  };
  app.get('/setup', (req, res) => {
    if (!guard(req, res)) return;
    const rows = SETUP_FIELDS.map(([k, label]) => {
      const set = process.env[k] ? ' (כבר מוגדר, השאר ריק כדי לא לשנות)' : '';
      return `<p style="text-align:right"><label>${esc(label)}${set}<br><input name="${k}" type="password" autocomplete="off" style="width:100%;padding:8px;font-size:16px"></label></p>`;
    }).join('');
    res.send(page('הגדרת קו הטלפון', `<form method="post" action="/setup"><input type="hidden" name="key" value="${esc(cfg.key)}">${rows}<button class="btn" style="border:0;cursor:pointer">שמור</button></form>`));
  });
  app.post('/setup', (req, res) => {
    if (!guard(req, res)) return;
    const values = {};
    for (const [k] of SETUP_FIELDS) {
      const v = String(req.body?.[k] || '').trim();
      if (v && !/[\r\n]/.test(v)) values[k] = v;
    }
    if (Object.keys(values).length) saveEnv(values);
    res.send(page('נשמר', '<p>ההגדרות נשמרו. השרת מופעל מחדש, ותוך כמה שניות הכל מוכן.</p>'));
    if (Object.keys(values).length && process.env.NO_RESTART !== '1') setTimeout(() => process.exit(0), 800);
  });
}

function addWebRoutes(app) {
  addSetupRoutes(app);
  addAdminRoutes(app);
  addPoolRoutes(app);
  app.use((_req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    next();
  });
  app.get('/connect', (req, res) => {
    const r = users.consumeLoginToken(String(req.query.t || ''));
    if (!r) {
      return res.status(400).send(page('הקישור לא תקף', '<p>הקישור פג תוקף או שכבר נעשה בו שימוש. אפשר לחזור לטלפון ולבקש קישור חדש.</p>'));
    }
    users.setEmailVerified(r.phone, r.email);
    const sid = users.createSession(r.phone);
    const g = gmail.googleEnabled()
      ? `<p>עוד צעד אחד: לאשר לקו הטלפון לקרוא ולענות להודעות בג׳ימייל שלך.</p><a class="btn" href="/auth/google?s=${encodeURIComponent(sid)}">חבר את הג׳ימייל</a>`
      : '<p>חיבור הג׳ימייל עדיין לא הופעל במערכת.</p>';
    res.send(page('הטלפון חובר', `<p>הטלפון שלך חובר לכתובת ${esc(r.email)}.</p>${g}`));
  });
  app.get('/auth/google', (req, res) => {
    const s = String(req.query.s || '');
    if (!users.getSession(s) || !gmail.googleEnabled()) return res.status(400).send(page('הפעולה לא תקפה', '<p>חזור לקישור שבמייל.</p>'));
    res.redirect(gmail.authUrl(s));
  });
  app.get('/auth/google/callback', async (req, res) => {
    const s = String(req.query.state || '');
    const sess = users.getSession(s);
    if (!sess || !req.query.code) return res.status(400).send(page('החיבור נכשל', '<p>נסה שוב דרך הקישור שבמייל.</p>'));
    try {
      const g = await gmail.exchangeCode(String(req.query.code));
      users.setGoogle(sess.phone, g);
      users.dropSession(s);
      res.send(page('הג׳ימייל חובר', `<p>הכל מוכן. אפשר לחזור לטלפון, ללחוץ 2 ולשמוע את המייל של ${esc(g.email)}.</p>`));
    } catch (e) {
      console.error('google callback', e.message);
      res.status(500).send(page('החיבור נכשל', '<p>משהו השתבש בחיבור מול גוגל. נסה שוב.</p>'));
    }
  });
}

// ---------- השרת ----------
export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = YemotRouter({
    printLog: cfg.debug,
    timeout: '15m',
    defaults: { removeInvalidChars: true },
    uncaughtErrorHandler: (error, call) => {
      console.error('שגיאה לא מטופלת:', error);
      return call.id_list_message([T('אירעה תקלה, נסה שוב מאוחר יותר'), { type: 'go_to_folder', data: 'hangup' }]);
    },
  });
  router.get('/', handler);
  router.post('/', handler);
  app.use('/ivr', router);
  addWebRoutes(app);
  app.get('/health', (_req, res) => res.send('ok'));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!cfg.key) console.warn('אזהרה: IVR_KEY לא מוגדר, השרת פתוח לכל מי שמכיר את הכתובת');
  if (cfg.aiProvider === 'gemini' && !cfg.geminiKey && !cfg.mock) console.warn('אזהרה: חסר GEMINI_API_KEY');
  console.log(`מנוע AI: ${cfg.aiProvider}`);
  const app = createApp();
  app.listen(cfg.port, () => console.log(`IVR server on :${cfg.port}`));
  // פורט נוסף (למשל 6080) לכניסה מהדפדפן כשחומת האש של השרת סוגרת את 3000
  if (process.env.EXTRA_PORT) app.listen(Number(process.env.EXTRA_PORT), () => console.log(`גם על :${process.env.EXTRA_PORT}`));
  llmWarm();
  setInterval(llmWarm, 4 * 60 * 1000).unref();
}
