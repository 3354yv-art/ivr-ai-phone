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
import * as web from './browser.js';
import { forumFor, dropForum, isForumHost, FORUMS, ago } from './nodebb.js';
import * as mail from './mail.js';
import * as gmail from './gmail.js';
import * as users from './users.js';
import { sendLoginEmail } from './notify.js';
import { addPoolRoutes, allKeys, isDonor } from './pool.js';
import { withCaller } from './ctx.js';
import { voiceFile, googleVoiceOn, DEFAULT_VOICE, RATES, VOICES } from './voice.js';
import { getSetting, setSetting as setLineSetting, addRule, listRules, removeRule } from './rules.js';
import { addMyRoutes } from './my.js';
import { addHomeRoutes } from './home.js';
import { addAdminRoutes, blockInfo, roleOf, blockPhone, unblockPhone, recentAll, phoneSummary, createAdminCode, addStaff, removeStaff, staffList, showPhone, isBlocked, logQuery, logAnswer, recentFor } from './admin.js';

const T = (data) => ({ type: 'text', data: clean(data) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// שגיאות "בקרה" של הספרייה (ניתוק, יציאה) חייבות לעבור הלאה ולא להיבלע
const isControl = (e) => e instanceof CallError;

// ---------- כלי עזר לשיחה ----------

// הקול של המתקשר: קול גוגל שבחר (או ברירת המחדל), או הקול הרגיל של ימות
const voiceOf = (call) => {
  const s = users.getSettings(call.phone);
  return { voice: s.voice || (googleVoiceOn() ? DEFAULT_VOICE : 'yemot'), rate: RATES[s.speed] || 1 };
};
// הודעה להשמעה: קובץ בקול של גוגל אם אפשר, אחרת טקסט בקול של ימות
async function say(call, text) {
  const t = clean(text);
  const { voice, rate } = voiceOf(call);
  const f = await voiceFile(t, voice, rate, tokenFor(call));
  return f ? { type: 'file', data: f } : T(t);
}

// שואל שאלה עם הקשה אחת
async function ask(call, text, allowed, opts = {}) {
  return call.read([await say(call, text)], 'tap', {
    max_digits: 1,
    min_digits: 1,
    sec_wait: 7,
    digits_allowed: allowed,
    ...opts,
  });
}

// ממתין לפעולה ארוכה (ג'מיני, אתר) ומשמיע מוזיקה. ימות לא מחכה יותר מכמה שניות לתשובה,
// לכן כל שנייה-שתיים חוזרים אליה עם הודעת המתנה קצרה עד שהפעולה מסתיימת.
// משפטי המתנה טבעיים במקום "אנא המתן" קבוע
const WAITS = ['רגע, אני בודק', 'שנייה', 'רק רגע', 'בודק ומיד חוזר', 'רגע אחד'];

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
      first ? [T(WAITS[Math.floor(Math.random() * WAITS.length)])] : [{ type: 'music_on_hold', data: { musicName: cfg.music, maxSec: 3 } }],
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
  const path = await call.read([await say(call, prompt)], 'record', {
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

// מקריא טקסט בקטעים. 1 או 0 = עצירה, 4 = אחורה, 6 = דילוג
async function speak(call, text) {
  // כל מה שהקו אומר נרשם לתיק, חוץ מתוכן מיילים
  if (!call.noLog && text) logAnswer(call.phone, 'הקו אמר', String(text).slice(0, 2000));
  const parts = chunk(text);
  if (!parts.length) {
    await call.read([T('אין מה להקריא')], 'tap', { max_digits: 1, sec_wait: 1, allow_empty: true, empty_val: 'None', digits_allowed: [] });
    return 'done';
  }
  // מכינים מראש את הקבצים של כמה קטעים, כדי שלא יהיו הפסקות
  const msgs = parts.map((p, j) => (j < 6 ? say(call, p) : null));
  let i = 0;
  while (i < parts.length) {
    const k = await call.read([await (msgs[i] || say(call, parts[i]))], 'tap', {
      max_digits: 1,
      min_digits: 1,
      sec_wait: 1,
      allow_empty: true,
      empty_val: 'None',
      digits_allowed: [0, 1, 4, 6],
    });
    if (k === '0' || k === '1') return 'stop';
    if (k === '4') i = Math.max(0, i - 1);
    else i += 1;
  }
  return 'done';
}

// מכסת שאלות יומית למי שלא תרם מפתח (0 = ללא הגבלה, נקבע באתר הניהול)
const daily = new Map();
async function quotaOk(call) {
  const limit = Number(getSetting('dailyLimit', 0));
  if (!limit || !call.phone || isDonor(call.phone)) return true;
  const k = `${new Date().toISOString().slice(0, 10)}|${call.phone}`;
  const n = (daily.get(k) || 0) + 1;
  daily.set(k, n);
  if (daily.size > 5000) daily.clear();
  if (n <= limit) return true;
  await speak(call, `הגעת למכסה של ${limit} שאלות להיום. תומכי הקו מקבלים שאלות ללא הגבלה. כדי לשמוע איך להצטרף, היכנס לאיזור האישי והקש 6`);
  return false;
}

// כתובת אתר כמו שאומרים אותה בטלפון: 129.159.151.3:6080 -> 129 נקודה 159 ... נקודתיים 6080
const spokenSite = (p) => `${(cfg.baseUrl || '').replace(/^https?:\/\//, '').replace(/\./g, ' נקודה ').replace(/:/g, ' נקודתיים ')} לוכסן ${p}`;

const donateInfo = () => `תומכי הקו מקבלים מענה מהיר בעדיפות, שאלות ללא הגבלה, תשובות מפורטות יותר, וזיכרון גדול יותר. כדי להצטרף, תורמים מפתח חינמי של גרוק. נכנסים לכתובת ${spokenSite('donate')}, באנגלית, ושם יש הסבר של דקה איך להשיג מפתח. בטופס מזינים גם את מספר הטלפון שממנו מתקשרים, וההטבות מתחילות מיד`;

// ---------- שלוחה 1: צ'אט ----------
// שיחה רציפה עם העוזר: מדברים, הוא עונה, ומיד אפשר לדבר שוב. בלי תפריטים באמצע.
// לחיצה על 1 באמצע תשובה עוצרת אותה. "די" / "תפריט" / שתי שתיקות - חזרה לתפריט.
// העוזר גם מבצע פעולות: חיפוש עדכני, כניסה לאתר, פורום, מייל, זיכרון, הגדרות.
async function chatMode(call) {
  // ממשיכים את השיחה הקודמת אם היא הייתה ב-12 השעות האחרונות
  const prev = users.getLastChat(call.phone);
  const history = prev ? [...prev] : [];
  const persona = () => users.personaOf(call.phone);
  let prompt = call.chatHintGiven ? 'כן?' : 'דברו אחרי הצליל, ובסיום הקישו סולמית';
  call.chatHintGiven = true;
  let silent = 0;
  let last = '';
  while (true) {
    const q = await listen(call, prompt, 30, 'שיחה עם AI');
    prompt = 'כן?';
    if (!q) {
      if (++silent >= 2) return;
      prompt = 'לא שמעתי. אפשר לדבר שוב, או לומר תפריט';
      continue;
    }
    silent = 0;
    if (/^\s*(תחזור על זה|שוב|עוד פעם|לא שמעתי)\s*[.?!]*\s*$/.test(q) && last) {
      await speak(call, last);
      continue;
    }
    if (!(await quotaOk(call))) return;
    const r = await waitFor(call, ai.chat(history, q, persona(), true));
    history.push({ role: 'user', text: q });
    let answer = '';
    switch (r.action) {
      case 'menu':
        await speak(call, 'חוזרים לתפריט');
        return;
      case 'search': {
        if (/מתמחים|mitmachim/i.test(r.query || q)) {
          await forumMode(call, 'mitmachim.top');
          answer = 'חזרנו לשיחה. מה עוד?';
          break;
        }
        const res = await waitFor(call, ai.search(r.query || q, persona()));
        answer = res.answer;
        break;
      }
      case 'site': {
        const name = r.name || q;
        const sc = findShortcut(call, name);
        const url = sc ? sc.url : /מתמחים|mitmachim/i.test(name) ? 'https://mitmachim.top' : await waitFor(call, ai.findSite(name));
        if (url) {
          await browse(call, url);
          answer = 'חזרנו לשיחה. מה עוד?';
        } else answer = 'לא מצאתי את האתר הזה';
        break;
      }
      case 'forum':
        await forumMode(call, 'mitmachim.top');
        answer = 'חזרנו לשיחה. מה עוד?';
        break;
      case 'mail':
        await mailMode(call);
        answer = 'חזרנו לשיחה. מה עוד?';
        break;
      case 'remember':
        if (call.phone && r.text) {
          users.addPref(call.phone, r.text);
          answer = 'רשמתי, אזכור את זה';
        } else answer = 'לא יכולתי לשמור את זה';
        break;
      case 'settings':
        await settingsMode(call);
        answer = 'חזרנו לשיחה. מה עוד?';
        break;
      default:
        answer = r.text || 'לא הבנתי, אפשר לומר במילים אחרות?';
    }
    history.push({ role: 'model', text: answer });
    if (history.length > (isDonor(call.phone) ? 40 : 20)) history.splice(0, 2);
    users.saveLastChat(call.phone, history);
    last = answer;
    await speak(call, answer);
  }
}

// פקודה קולית לסוכן. מחזיר את הפעולה שהסוכן הבין, או null אם לא נשמע דבר
async function agentCommand(call, page, history = []) {
  const cmd = await listen(call, 'העוזר החכם. אמור מה לעשות', 25, 'פקודה לסוכן');
  if (!cmd) {
    await speak(call, 'לא שמעתי');
    return null;
  }
  const act = await waitFor(call, ai.agent(page, cmd, history, users.personaOf(call.phone)));
  if (act?.action === 'open') logAnswer(call.phone, 'העוזר פתח', act.title || act.url);
  return act;
}

// ---------- דפדוף באתר: שיחה עם עוזר על הדף ----------
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// מאזין לבקשה. אחרי שתי שתיקות מציע תפריט מקשים קצר. מחזיר טקסט, או null ליציאה
async function hear(call, prompt, kind) {
  for (let miss = 0; miss < 2; miss++) {
    const t = await listen(call, miss ? 'לא שמעתי, אפשר לומר שוב' : prompt, 25, kind);
    if (t) return t;
  }
  const c = await ask(call, 'לא שמעתי. כדי לומר משהו הקש 1, ליציאה הקש 0', [0, 1], { sec_wait: 7, allow_empty: true, empty_val: '0' });
  return c === '1' ? hear(call, prompt, kind) : null;
}

// אם המתקשר אמר "תלחץ על X" ו-X הוא בדיוק שם של כפתור או קישור בדף, לוחצים מיד בלי לשאול את ה-AI
const nrm = (s) => String(s || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function directClick(page, cmd) {
  const m = String(cmd).match(/^\s*(?:תלחץ|לחץ|תלחצי|תקיש|תיכנס|כנס|תפתח|פתח)\s+(?:על\s+|ל|את\s+)?(.{2,60})$/);
  if (!m) return null;
  const want = nrm(m[1]);
  const els = (page.els || []).filter((e) => e.kind !== 'שדה');
  const exact = els.filter((e) => nrm(e.text) === want);
  const pick = exact.length === 1 ? exact[0] : (() => { const c = els.filter((e) => nrm(e.text).includes(want) && want.length >= 3); return c.length === 1 ? c[0] : null; })();
  return pick ? { action: 'click', index: pick.i, title: pick.text } : null;
}

// דפדפן אמיתי: העוזר לוחץ על כפתורים וממלא שדות
async function browseLive(call, startUrl) {
  const id = String(call.callId || call.phone || Math.random());
  const persona = users.personaOf(call.phone);
  let page;
  try {
    page = { ...(await waitFor(call, web.open(id, startUrl))), interactive: true };
  } catch (e) {
    if (isControl(e)) throw e;
    console.error('browser open', startUrl, e.message);
    return 'fallback';
  }
  const history = [];
  let depth = 0;
  try {
    const guide = await waitFor(call, ai.pageGuide(page, persona));
    history.push({ role: 'model', text: guide });
    await speak(call, guide);
    while (true) {
      if (isForumHost(hostOf(page.url))) {
        await forumMode(call, hostOf(page.url));
        return;
      }
      const cmd = await hear(call, 'אני מקשיב', 'פקודה לסוכן');
      if (cmd === null) return;
      history.push({ role: 'user', text: cmd });
      const act = directClick(page, cmd) || (await waitFor(call, ai.agent(page, cmd, history, persona)));
      let note = '';
      try {
        if (act.action === 'click') {
          logAnswer(call.phone, 'העוזר לחץ', act.title);
          const before = page.url;
          page = { ...(await waitFor(call, web.act(id, { type: 'click', index: act.index }))), interactive: true };
          if (page.url !== before) depth++;
          note = await waitFor(call, ai.pageGuide(page, persona));
        } else if (act.action === 'fill') {
          logAnswer(call.phone, 'העוזר כתב בשדה', act.text);
          const before = page.url;
          page = { ...(await waitFor(call, web.act(id, { type: 'fill', index: act.index, text: act.text, submit: act.submit }))), interactive: true };
          if (page.url !== before) depth++;
          note = act.submit ? await waitFor(call, ai.pageGuide(page, persona)) : `כתבתי ${act.text}. מה עכשיו?`;
        } else if (act.action === 'back') {
          if (depth <= 0) {
            await speak(call, 'יוצא מהאתר');
            return;
          }
          depth--;
          page = { ...(await waitFor(call, web.act(id, { type: 'back' }))), interactive: true };
          note = await waitFor(call, ai.pageGuide(page, persona));
        } else if (act.action === 'read') {
          const from = act.from ? page.text.indexOf(act.from) : -1;
          await speak(call, page.text.slice(Math.max(0, from)));
          note = 'זהו. מה עוד?';
        } else if (act.action === 'summary') {
          note = await waitFor(call, ai.summarize(page.text));
        } else if (act.action === 'search' && act.query) {
          note = (await waitFor(call, ai.search(act.query, persona))).answer;
        } else {
          note = act.text || 'לא הבנתי, אפשר לומר במילים אחרות?';
        }
      } catch (e) {
        if (isControl(e)) throw e;
        console.error('browser act', act.action, e.message);
        note = 'לא הצלחתי לעשות את זה בדף. אפשר לנסות במילים אחרות';
      }
      history.push({ role: 'model', text: note });
      await speak(call, note);
    }
  } finally {
    web.close(id);
  }
}

async function browse(call, startUrl) {
  if (isForumHost(hostOf(startUrl))) return forumMode(call, hostOf(startUrl));
  if (!cfg.mock && (await web.available()) && (await browseLive(call, startUrl)) !== 'fallback') return;
  const persona = users.personaOf(call.phone);
  const stack = [];
  let url = startUrl;
  while (url) {
    if (isForumHost(hostOf(url))) {
      await forumMode(call, hostOf(url));
      url = stack.pop() ?? null;
      continue;
    }
    let page;
    try {
      page = await waitFor(call, fetchPage(url));
    } catch (e) {
      if (isControl(e)) throw e;
      console.error('fetchPage', url, e.message);
      await speak(call, 'לא הצלחתי לפתוח את הדף');
      url = stack.pop() ?? null;
      continue;
    }
    const history = [];
    const guide = await waitFor(call, ai.pageGuide(page, persona));
    history.push({ role: 'model', text: guide });
    await speak(call, guide);
    let next;
    while (next === undefined) {
      const cmd = await hear(call, 'אני מקשיב', 'פקודה לסוכן');
      if (cmd === null) {
        next = stack.pop() ?? null;
        break;
      }
      const act = await waitFor(call, ai.agent(page, cmd, history, persona));
      history.push({ role: 'user', text: cmd });
      if (act.action === 'open') {
        logAnswer(call.phone, 'העוזר פתח', act.title || act.url);
        history.push({ role: 'model', text: `נכנס ל${act.title}` });
        await speak(call, `נכנס ל${act.title}`);
        stack.push(url);
        next = act.url;
      } else if (act.action === 'back') {
        next = stack.pop() ?? null;
        if (next === null) await speak(call, 'יוצא מהאתר');
      } else if (act.action === 'read') {
        const from = act.from ? page.text.indexOf(act.from) : -1;
        history.push({ role: 'model', text: 'הקראתי את הדף' });
        await speak(call, page.text.slice(Math.max(0, from)));
        await speak(call, 'זהו. מה עוד?');
      } else if (act.action === 'summary') {
        const s = await waitFor(call, ai.summarize(page.text));
        history.push({ role: 'model', text: s });
        await speak(call, s);
      } else if (act.action === 'search' && act.query) {
        const res = await waitFor(call, ai.search(act.query, persona));
        history.push({ role: 'model', text: res.answer });
        await speak(call, res.answer);
      } else {
        const t = act.text || 'לא הבנתי, אפשר לומר במילים אחרות?';
        history.push({ role: 'model', text: t });
        await speak(call, t);
      }
    }
    url = next;
  }
}

// חיבור חשבון בפורום דרך הטלפון: שם משתמש בקול או מייל בהקלדה, וסיסמה בהקלדה. נבדק מול הפורום לפני שמירה
async function forumConnect(call, host) {
  const name = FORUMS[host] || host;
  if (!call.phone) return speak(call, 'אי אפשר לחבר חשבון משיחה ממספר חסוי');
  const kb = { typing_playback_mode: 'EmailKeyboard', min_digits: 1, sec_wait: 40, allow_empty: true, empty_val: 'None' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const how = await ask(call, `חיבור החשבון ב${name}. כדי להקליד את כתובת המייל של החשבון באנגלית, הקישו 1. כדי לומר את שם המשתמש בקול, 2. לחזרה, 0`, [0, 1, 2], { sec_wait: 8, allow_empty: true, empty_val: '0' });
    if (how === '0') return;
    let user = '';
    if (how === '1') {
      const t = await call.read([await say(call, 'הקלידו את כתובת המייל, ובסיום סולמית')], 'tap', kb);
      user = t && t !== 'None' ? String(t).trim() : '';
    } else {
      const t = await listen(call, 'אמרו את שם המשתמש שלכם בפורום', 10, null);
      if (t) {
        const ok = await ask(call, `שמעתי: ${t}. אם נכון, הקישו 1. לנסות שוב, 2`, [1, 2], { sec_wait: 7, allow_empty: true, empty_val: '2' });
        if (ok === '1') user = t.replace(/[.,!?]+$/, '').trim();
      }
    }
    if (!user) continue;
    const p = await call.read([await say(call, 'עכשיו הקלידו את הסיסמה, ובסיום סולמית')], 'tap', kb);
    const pw = p && p !== 'None' ? String(p) : '';
    if (!pw) continue;
    try {
      const f = new (await import('./nodebb.js')).Forum(host);
      const me = await waitFor(call, f.login(user, pw));
      users.setSiteAccount(call.phone, host, user, pw);
      dropForum(call.phone, host);
      return speak(call, `החשבון חובר בהצלחה, בתור ${me.username || user}`);
    } catch (e) {
      if (isControl(e)) throw e;
      await speak(call, 'ההתחברות נכשלה. כנראה שם המשתמש או הסיסמה לא נכונים. אפשר לנסות שוב, או לחבר באיזור האישי באתר');
    }
  }
}

// ---------- פורום (מתמחים טופ ודומיו): קריאה, כתיבה, צ'אטים ----------
const nums = ['אחד', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר', 'אחת עשרה', 'שתים עשרה'];

async function confirm(call, what) {
  const c = await ask(call, `${what}. לשליחה הקש 1, לביטול הקש 2`, [1, 2], { sec_wait: 10, allow_empty: true, empty_val: '2' });
  return c === '1';
}

async function forumMode(call, host) {
  const name = FORUMS[host] || host;
  const persona = users.personaOf(call.phone);
  const creds = call.phone ? users.getSiteAccount(call.phone, host) : null;
  let f;
  try {
    f = await waitFor(call, forumFor(call.phone || 'x', host, creds));
  } catch (e) {
    if (isControl(e)) throw e;
    console.error('forum', host, e.message);
    if (creds) {
      await speak(call, `לא הצלחתי להתחבר לחשבון שלך ב${name}. ${/סיסמה|נכשלה/.test(e.message) ? 'כנראה שם המשתמש או הסיסמה השתנו' : 'האתר לא ענה'}. נכנס כאורח`);
      try {
        f = await waitFor(call, forumFor(call.phone || 'x', host, null));
      } catch (e2) {
        if (isControl(e2)) throw e2;
      }
    }
    if (!f) {
      await speak(call, `לא הצלחתי להיכנס ל${name} כרגע`);
      return;
    }
  }
  const state = { forum: name, where: 'דף ראשי', list: [], detail: '' };
  let items = [];
  let kind = 'topics'; // topics | chats
  let topic = null;
  let pos = 0;
  let room = null;
  const history = [];
  const say = async (t) => {
    history.push({ role: 'model', text: t.slice(0, 400) });
    return speak(call, t);
  };
  const needLogin = async () => {
    if (f.loggedIn) return false;
    const c = await ask(call, `בשביל זה צריך לחבר את החשבון שלך ב${name}. לחיבור עכשיו, הקישו 1. להמשך בלי, 2`, [1, 2], { sec_wait: 7, allow_empty: true, empty_val: '2' });
    if (c === '1') {
      await forumConnect(call, host);
      const creds2 = users.getSiteAccount(call.phone, host);
      if (creds2) {
        try {
          f = await waitFor(call, forumFor(call.phone, host, creds2));
          if (f.loggedIn) {
            await say('מחובר. אפשר לבקש שוב');
            return true;
          }
        } catch (e) {
          if (isControl(e)) throw e;
        }
      }
    }
    return true;
  };
  const showTopics = async (list, title) => {
    items = list;
    kind = 'topics';
    state.where = title;
    state.list = list.map((t) => `${t.title} (מאת ${t.by}, ${t.posts} הודעות, ${ago(t.last)}${t.cat ? `, ב${t.cat}` : ''})`);
    if (!list.length) return say(`אין כרגע ${title}`);
    const top = list.slice(0, 7).map((t, i) => `${nums[i]}: ${t.title}, של ${t.by}, ${ago(t.last)}`).join('. ');
    return say(`${title}. ${top}. איזה נושא לפתוח?`);
  };
  const readPosts = async (n) => {
    const part = topic.posts.slice(pos, pos + n);
    if (!part.length) return say('אין עוד הודעות בנושא. אפשר להגיב, או לבקש נושאים אחרים');
    pos += part.length;
    const txt = part.map((p) => `${p.by} כתב ${ago(p.at)}: ${p.text}`).join('. ');
    const left = topic.posts.length - pos;
    const r = await say(`${txt}. ${left > 0 ? `יש עוד ${left} תגובות. להמשך אמור תמשיך` : 'זה הכל בנושא. אפשר להגיב'}`);
    return r;
  };

  await say(f.loggedIn ? `נכנסת ל${name}, בחשבון ${f.user.username}` : `נכנסת ל${name} כאורח. כדי לכתוב ולקרוא צ'אטים צריך לחבר את החשבון באיזור האישי באתר`);
  try {
    await showTopics(await waitFor(call, f.topics(f.loggedIn ? 'unread' : 'recent')), f.loggedIn ? 'נושאים שלא קראת' : 'הנושאים האחרונים');
  } catch (e) {
    if (isControl(e)) throw e;
    await say('לא הצלחתי לטעון את הנושאים');
  }

  while (true) {
    const cmd = await hear(call, 'מה לעשות?', `פורום ${name}`);
    if (cmd === null) return;
    history.push({ role: 'user', text: cmd });
    const act = await waitFor(call, ai.forumAgent(state, cmd, history, persona));
    try {
      switch (act.action) {
        case 'recent':
        case 'popular':
          await showTopics(await waitFor(call, f.topics(act.action)), act.action === 'popular' ? 'הנושאים החמים' : 'הנושאים האחרונים');
          break;
        case 'unread':
          if (await needLogin()) break;
          await showTopics(await waitFor(call, f.topics('unread')), 'נושאים שלא קראת');
          break;
        case 'search': {
          const r = await waitFor(call, f.searchPosts(act.query || cmd));
          await showTopics(r.map((x) => ({ ...x, posts: '', last: '', cat: '' })), `תוצאות חיפוש על ${act.query || cmd}`);
          break;
        }
        case 'open': {
          const it = items[Number(act.index) - 1];
          if (!it) {
            await say('לא מצאתי פריט כזה ברשימה');
            break;
          }
          if (kind === 'chats') {
            room = it;
            const msgs = await waitFor(call, f.chatMessages(it.roomId));
            state.where = `צ'אט עם ${it.name}`;
            state.detail = msgs.map((m) => `${m.mine ? 'אני' : m.by}: ${m.text}`).join('\n');
            logAnswer(call.phone, 'פורום: צ׳אט', it.name);
            await say(msgs.length ? `הצ'אט עם ${it.name}. ${msgs.slice(-8).map((m) => `${m.mine ? 'אתה כתבת' : `${m.by} כתב`} ${ago(m.at)}: ${m.text}`).join('. ')}. אפשר להגיד מה לענות` : `הצ'אט עם ${it.name} ריק. מה לכתוב?`);
          } else {
            topic = await waitFor(call, f.topic(it.tid));
            pos = 0;
            state.where = `נושא: ${topic.title}`;
            state.detail = topic.posts.map((p) => `${p.by}: ${p.text}`).join('\n');
            logAnswer(call.phone, 'פורום: נכנס לנושא', topic.title);
            await say(`${topic.title}. ${topic.posts.length} הודעות`);
            await readPosts(3);
          }
          break;
        }
        case 'more':
          if (topic) await readPosts(3);
          else await say('אין נושא פתוח');
          break;
        case 'summary':
          if (topic) await say(await waitFor(call, ai.narrate('סכם למתקשר בקצרה ובשפה מדוברת את הדיון הזה בפורום: על מה שואלים, מה ענו, והאם נפתרה הבעיה.', state.detail, persona)));
          else await say('אין נושא פתוח לסכם');
          break;
        case 'reply': {
          if (await needLogin()) break;
          if (!topic) {
            await say('קודם צריך לפתוח נושא כדי להגיב בו');
            break;
          }
          if (!act.text) {
            await say('מה לכתוב בתגובה?');
            break;
          }
          if (await confirm(call, `התגובה שתישלח לנושא ${topic.title}: ${act.text}`)) {
            await waitFor(call, f.reply(topic.tid, act.text));
            logAnswer(call.phone, 'פורום: נשלחה תגובה', `${topic.title}: ${act.text}`);
            await say('התגובה פורסמה');
          } else await say('בוטל. מה לשנות?');
          break;
        }
        case 'new_topic': {
          if (await needLogin()) break;
          const cats = await waitFor(call, f.categories());
          let cat = cats.find((c) => act.category && (c.name.includes(act.category) || act.category.includes(c.name)));
          if (!cat) {
            const list = cats.slice(0, 9);
            const n = await ask(call, `באיזו קטגוריה? ${list.map((c, i) => `${c.name} הקש ${i + 1}`).join(', ')}`, list.map((_, i) => i + 1), { sec_wait: 10, allow_empty: true, empty_val: '0' });
            cat = list[Number(n) - 1];
          }
          if (!cat || !act.title || !act.text) {
            await say('לא היה לי מספיק מידע כדי לפתוח נושא. אמור מה הכותרת ומה לכתוב');
            break;
          }
          if (await confirm(call, `נושא חדש בקטגוריה ${cat.name}. הכותרת: ${act.title}. התוכן: ${act.text}`)) {
            await waitFor(call, f.newTopic(cat.cid, act.title, act.text));
            logAnswer(call.phone, 'פורום: נפתח נושא', `${act.title}: ${act.text}`);
            await say('הנושא פורסם');
          } else await say('בוטל. מה לשנות?');
          break;
        }
        case 'chats': {
          if (await needLogin()) break;
          const rooms = await waitFor(call, f.chats());
          items = rooms;
          kind = 'chats';
          state.where = 'רשימת צ׳אטים';
          state.list = rooms.map((r) => `${r.name}${r.unread ? ' (חדש)' : ''}: ${r.last.slice(0, 60)}`);
          await say(rooms.length ? `יש לך ${rooms.length} צ'אטים. ${rooms.slice(0, 7).map((r, i) => `${nums[i]}: ${r.name}${r.unread ? ', יש הודעה חדשה' : ''}`).join('. ')}. איזה לפתוח?` : 'אין לך צ׳אטים');
          break;
        }
        case 'send_chat': {
          if (await needLogin()) break;
          if (!room) {
            await say('קודם צריך לפתוח צ׳אט');
            break;
          }
          if (act.text && (await confirm(call, `ההודעה ל${room.name}: ${act.text}`))) {
            await waitFor(call, f.sendChat(room.roomId, act.text));
            logAnswer(call.phone, 'פורום: נשלחה הודעה', `${room.name}: ${act.text}`);
            await say('נשלח');
          } else await say('לא נשלח');
          break;
        }
        case 'notifications': {
          if (await needLogin()) break;
          const ns = await waitFor(call, f.notifications());
          await say(ns.length ? ns.slice(0, 6).map((n) => `${n.read ? '' : 'חדש: '}${n.text}, ${ago(n.at)}`).join('. ') : 'אין התראות');
          break;
        }
        case 'exit':
          await speak(call, `יוצא מ${name}`);
          return;
        default:
          await say(act.text || 'לא הבנתי, אפשר לומר במילים אחרות?');
      }
    } catch (e) {
      if (isControl(e)) throw e;
      console.error('forum action', act.action, e.message);
      await say(/נכשל/.test(e.message) ? e.message : 'משהו השתבש מול הפורום, נסה שוב');
      if (/401|403/.test(e.message)) dropForum(call.phone || 'x', host);
    }
  }
}

// ---------- שלוחה 3: חיפוש ----------
async function searchMode(call) {
  while (true) {
    let q = await listen(call, 'מה לחפש בגוגל', 25, 'חיפוש');
    if (!q) {
      const c = await ask(call, 'לא שמעתי. לנסות שוב הקש 1, לתפריט הראשי הקש 0', [0, 1], { allow_empty: true, empty_val: '0' });
      if (c === '1') continue;
      return;
    }
    if (!(await quotaOk(call))) return;
    if (/מתמחים|mitmachim/i.test(q)) {
      await forumMode(call, 'mitmachim.top');
      return;
    }
    q = await waitFor(call, ai.fixQuery(q));
    const res = await waitFor(call, ai.search(q, users.personaOf(call.phone)));
    let more = true;
    while (more) {
      const sr = await speak(call, res.answer);
      if (sr === 'stop') {
        const pseudo = { title: q, text: res.answer, links: res.sources.map((x) => ({ text: x.title, url: x.url })) };
        const act = await agentCommand(call, pseudo);
        if (act?.action === 'open') {
          await speak(call, `נכנס ל${act.title}`);
          await browse(call, act.url);
          continue;
        }
        if (act?.action === 'summary' || act?.action === 'answer') await speak(call, act.action === 'answer' ? act.text || 'אין לי תשובה' : await waitFor(call, ai.summarize(res.answer)));
        if (act?.action === 'read') continue;
      }
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

// קיצורים: של המתקשר, ושל המנהל לכולם
const allShortcuts = (call) => [...users.getShortcuts(call.phone), ...(getSetting('shortcuts', []) || [])];
function findShortcut(call, name) {
  const n = String(name).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  return allShortcuts(call).find((s) => n && (n.includes(s.name) || s.name.includes(n)));
}

async function shortcutsMode(call) {
  const list = allShortcuts(call).slice(0, 9);
  if (!list.length) {
    await speak(call, 'עדיין אין קיצורים. אפשר להוסיף קיצורים באיזור האישי, בהקשה 9, או באתר האישי');
    return;
  }
  const n = await ask(call, `${list.map((s, i) => `ל${s.name}, ${i + 1}`).join('. ')}. לחזרה, 0`, [0, ...list.map((_, i) => i + 1)], { sec_wait: 8, allow_empty: true, empty_val: '0' });
  const s = list[Number(n) - 1];
  if (s) await browse(call, s.url);
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
    const sc = findShortcut(call, name);
    const url = sc ? sc.url : /מתמחים|mitmachim/i.test(name) ? 'https://mitmachim.top' : await waitFor(call, ai.findSite(name));
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
  const app = users.getAppAccount(call.phone);
  if (app) return mail.accountProvider(app.user, app.pass);
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
  const how = await ask(call, 'לחיבור מיידי בהקשת כתובת הג׳ימייל וסיסמת אפליקציה הקש 1, לקבלת קישור במייל הקש 2, לביטול הקש 0', [0, 1, 2], { sec_wait: 10, allow_empty: true, empty_val: '0' });
  if (how === '1') return appPasswordFlow(call);
  if (how !== '2') return;
  return linkFlow(call);
}

// חיבור בהקשה: כתובת ג׳ימייל + סיסמת אפליקציה (16 אותיות). נבדק מול ג׳ימייל לפני שמירה
async function appPasswordFlow(call) {
  const kb = { typing_playback_mode: 'EmailKeyboard', min_digits: 1, sec_wait: 40, allow_empty: true, empty_val: 'None' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed = await call.read([T('הקש את כתובת הג׳ימייל שלך באנגלית, ובסיום הקש סולמית')], 'tap', kb);
    if (!typed || typed === 'None') return;
    const email = String(typed).trim().toLowerCase();
    if (!/^[^\s@]+@(gmail|googlemail)\.com$/.test(email)) {
      await speak(call, 'הכתובת צריכה להיות כתובת ג׳ימייל תקינה');
      continue;
    }
    const pw = await call.read([T('עכשיו הקש את סיסמת האפליקציה, שש עשרה אותיות, ובסיום הקש סולמית')], 'tap', kb);
    if (!pw || pw === 'None') return;
    const pass = String(pw).replace(/\s/g, '').toLowerCase();
    if (!/^[a-z]{16}$/.test(pass)) {
      await speak(call, 'סיסמת אפליקציה היא שש עשרה אותיות באנגלית');
      continue;
    }
    const ok = await waitFor(call, mail.verifyAccount(email, pass));
    if (!ok) {
      await speak(call, 'ההתחברות לג׳ימייל נכשלה. בדוק את הכתובת והסיסמה');
      continue;
    }
    users.setAppPassword(call.phone, email, pass);
    await speak(call, 'הג׳ימייל חובר בהצלחה. אפשר לשמוע את ההודעות מהתפריט הראשי בהקשת 3');
    return;
  }
}

async function linkFlow(call) {
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
  // תוכן מיילים לא נרשם לתיק
  call.noLog = true;
  try {
    return await mailModeInner(call);
  } finally {
    call.noLog = false;
  }
}

async function mailModeInner(call) {
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
    const state = u?.google?.refresh || u?.app ? 'הג׳ימייל שלך מחובר' : 'הג׳ימייל שלך עדיין לא מחובר';
    const np = users.getPrefs(call.phone).length;
    const c = await ask(call, `האיזור האישי. ${state}. ${np ? `העוזר זוכר עליך ${np} דברים` : ''}. לשמיעת החיפושים האחרונים שלך הקש 1, לחיבור ג׳ימייל או מתמחים טופ הקש 2, כדי לספר לעוזר משהו או להגיד לו איך לענות לך הקש 3, לשמיעת מה שהעוזר זוכר עליך הקש 4, למחיקת כל מה שהעוזר זוכר הקש 5, ${isDonor(call.phone) ? 'אתה מתומכי הקו, תודה' : 'כדי לשמוע איך להיות מתומכי הקו ולקבל הטבות הקש 6'}, לקבלת קוד כניסה לאיזור האישי באתר הקש 7, להגדרות קול ואורך תשובות הקש 8, לקיצורי אתרים הקש 9, לתפריט הראשי הקש 0`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { sec_wait: 9, allow_empty: true, empty_val: '0' });
    if (c === '0') return;
    if (c === '1') {
      const mine = recentFor(call.phone, 3);
      await speak(call, mine.length ? mine.map((r, i) => `${i + 1}, ${r.q}`).join('. ') : 'עדיין אין חיפושים');
    } else if (c === '2') {
      const w = await ask(call, 'לחיבור ג׳ימייל, הקישו 1. לחיבור החשבון במתמחים טופ, 2. לחזרה, 0', [0, 1, 2], { sec_wait: 7, allow_empty: true, empty_val: '0' });
      if (w === '1') await registerFlow(call);
      else if (w === '2') await forumConnect(call, 'mitmachim.top');
    } else if (c === '3') {
      if (!call.phone) {
        await speak(call, 'לא ניתן לשמור התאמה אישית משיחה ממספר חסוי');
        continue;
      }
      const t = await listen(call, 'אמור מה העוזר צריך לדעת עליך או איך לענות לך. למשל: קוראים לי משה, או: תענה לי תמיד בקצרה', 30, 'התאמה אישית');
      if (t) {
        users.addPref(call.phone, t);
        await speak(call, `רשמתי: ${t}`);
      } else await speak(call, 'לא שמעתי');
    } else if (c === '4') {
      const p = users.getPrefs(call.phone);
      await speak(call, p.length ? p.map((x, i) => `${i + 1}, ${x}`).join('. ') : 'העוזר עדיין לא זוכר עליך כלום');
    } else if (c === '8') {
      await settingsMode(call);
    } else if (c === '9') {
      await shortcutEdit(call);
    } else if (c === '7') {
      if (!call.phone) {
        await speak(call, 'אי אפשר להיכנס לאתר משיחה ממספר חסוי');
        continue;
      }
      const code = users.createWebCode(call.phone);
      const spaced = code.split('').join(', ');
      const site = spokenSite('my');
      await speak(call, `הקוד שלך הוא: ${spaced}. אחזור שוב: ${spaced}. הקוד תקף לרבע שעה. נכנסים לאתר ${site}, באנגלית, ומזינים את מספר הטלפון ואת הקוד. אחרי זה נשארים מחוברים. שם אפשר לחבר מייל וחשבון בפורום, ולראות מה העוזר זוכר עליך`);
    } else if (c === '6') {
      await speak(call, isDonor(call.phone) ? 'אתה כבר מתומכי הקו ומקבל את כל ההטבות. תודה רבה' : donateInfo());
    } else if (c === '5') {
      users.clearPrefs(call.phone);
      await speak(call, 'נמחק');
    }
  }
}

// הגדרות אישיות בטלפון: קול, אורך תשובות, מהירות דיבור
async function settingsMode(call) {
  if (!call.phone) return speak(call, 'אי אפשר לשמור הגדרות משיחה ממספר חסוי');
  while (true) {
    const c = await ask(call, 'לבחירת קול, הקישו 1. לאורך התשובות, 2. למהירות הדיבור, 3. לחזרה, 0', [0, 1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '0' });
    if (c === '0') return;
    if (c === '1') {
      if (!googleVoiceOn()) {
        await speak(call, 'בחירת קולות עדיין לא הופעלה בקו. המנהל צריך להגדיר מפתח של גוגל קלאוד');
        continue;
      }
      const vs = VOICES;
      const n = await ask(call, `${vs.map((x, i) => `ל${x.name}, ${i + 1}`).join('. ')}. לחזרה, 0`, [0, ...vs.map((_, i) => i + 1)], { sec_wait: 8, allow_empty: true, empty_val: '0' });
      const pick = vs[Number(n) - 1];
      if (pick) {
        users.setSetting(call.phone, 'voice', pick.id);
        await speak(call, `נבחר ${pick.name}. ככה אני נשמע עכשיו`);
      }
    } else if (c === '2') {
      const n = await ask(call, 'לתשובות קצרות, 1. בינוניות, 2. מפורטות, 3', [1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '2' });
      users.setSetting(call.phone, 'length', { 1: 'short', 2: 'medium', 3: 'long' }[n]);
      await speak(call, 'נשמר');
    } else if (c === '3') {
      if (!googleVoiceOn()) {
        await speak(call, 'שינוי מהירות זמין רק עם הקולות של גוגל, שעדיין לא הופעלו בקו');
        continue;
      }
      const n = await ask(call, 'לדיבור איטי, 1. רגיל, 2. מהיר, 3', [1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '2' });
      users.setSetting(call.phone, 'speed', { 1: 'slow', 2: 'normal', 3: 'fast' }[n]);
      await speak(call, 'נשמר. ככה אני מדבר עכשיו');
    }
  }
}

// קיצורי אתרים אישיים: אומרים שם קצר ואיזה אתר, ואחר כך נכנסים אליו מיד
async function shortcutEdit(call) {
  if (!call.phone) return speak(call, 'אי אפשר לשמור קיצורים משיחה ממספר חסוי');
  while (true) {
    const list = users.getShortcuts(call.phone);
    const c = await ask(call, `יש לך ${list.length} קיצורים. לשמיעתם, הקישו 1. להוספת קיצור, 2. למחיקת קיצור, 3. לחזרה, 0`, [0, 1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '0' });
    if (c === '0') return;
    if (c === '1') await speak(call, list.length ? list.map((s, i) => `${i + 1}, ${s.name}`).join('. ') : 'אין עדיין קיצורים');
    else if (c === '2') {
      const site = await listen(call, 'איזה אתר? אמרו את שם האתר', 25, 'הוספת קיצור');
      if (!site) continue;
      const url = /מתמחים|mitmachim/i.test(site) ? 'https://mitmachim.top' : await waitFor(call, ai.findSite(site));
      if (!url) {
        await speak(call, 'לא מצאתי את האתר');
        continue;
      }
      const name = (await listen(call, 'ואיך לקרוא לקיצור? למשל: חדשות', 10, 'הוספת קיצור')) || site;
      users.addShortcut(call.phone, name, url);
      await speak(call, `נשמר הקיצור ${name}. בחיפוש ואתרים, בהקשה 4, או כשאומרים את השם בכניסה לאתר`);
    } else if (c === '3') {
      if (!list.length) continue;
      const n = await ask(call, `${list.slice(0, 9).map((s, i) => `למחיקת ${s.name}, ${i + 1}`).join('. ')}`, list.slice(0, 9).map((_, i) => i + 1), { sec_wait: 8, allow_empty: true, empty_val: '0' });
      if (list[Number(n) - 1]) {
        users.removeShortcut(call.phone, Number(n) - 1);
        await speak(call, 'נמחק');
      }
    }
  }
}

// ---------- ניהול בקו: למנהל הקו ולצוות הפיקוח ----------
// הקשת מספר טלפון בסולמית
async function typePhone(call, prompt) {
  const t = await call.read([await say(call, prompt)], 'tap', { min_digits: 9, max_digits: 10, sec_wait: 15, allow_empty: true, empty_val: 'X', typing_playback_mode: 'Digits' });
  const p = String(t || '').replace(/\D/g, '');
  return p.length >= 9 ? p : '';
}
const spellPhone = (p) => showPhone(String(p).replace(/\D/g, '').slice(-9)).split('').join(' ');
const durKey = { 1: 'hour', 2: 'day', 3: 'week', 4: 'month', 5: 'forever' };
const durSpoken = { hour: 'לשעה', day: 'ליום', week: 'לשבוע', month: 'לחודש', forever: 'לצמיתות' };

async function manageMode(call) {
  while (true) {
    const role = roleOf(call.phone);
    if (!role) return;
    const owner = role === 'owner';
    const c = await ask(call, `תפריט ניהול${owner ? '' : ' לצוות הפיקוח'}. לחסימת מספר, 1. לשחרור חסימה, 2. לשמיעת הפעילות האחרונה, 3. לבדיקת מספר, 4. לקוד כניסה לאתר הניהול, 5.${owner ? ' להוראות ל-AI, 6. לצוות הפיקוח, 7. למכסת שאלות יומית, 8.' : ''} לחזרה, 0`, owner ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [0, 1, 2, 3, 4, 5], { sec_wait: 8, allow_empty: true, empty_val: '0' });
    if (c === '0') return;
    if (c === '1') {
      const p = await typePhone(call, 'הקישו את המספר לחסימה, ובסיום סולמית');
      if (!p) continue;
      if (roleOf(p) === 'owner') {
        await speak(call, 'אי אפשר לחסום את מנהל הקו');
        continue;
      }
      const dk = durKey[await ask(call, 'לכמה זמן? לשעה, 1. ליום, 2. לשבוע, 3. לחודש, 4. לצמיתות, 5', [1, 2, 3, 4, 5], { sec_wait: 8, allow_empty: true, empty_val: '2' })] || 'day';
      const reason = await listen(call, 'אמרו את סיבת החסימה, כפי שתוקרא למתקשר. אפשר גם לשתוק', 15, 'ניהול: סיבת חסימה');
      blockPhone(p, reason, dk, call.phone);
      logAnswer(call.phone, 'ניהול: חסימה', `${showPhone(p.slice(-9))} ${durSpoken[dk]}${reason ? `: ${reason}` : ''}`);
      await speak(call, `המספר ${spellPhone(p)} נחסם ${durSpoken[dk]}${reason ? `. הסיבה: ${reason}` : ''}`);
    } else if (c === '2') {
      const p = await typePhone(call, 'הקישו את המספר לשחרור, ובסיום סולמית');
      if (!p) continue;
      const ok = unblockPhone(p);
      logAnswer(call.phone, 'ניהול: שחרור חסימה', showPhone(p.slice(-9)));
      await speak(call, ok ? `החסימה של ${spellPhone(p)} שוחררה` : 'המספר הזה לא היה חסום');
    } else if (c === '3') {
      const r = recentAll(8);
      await speak(call, r.length ? r.map((x) => `ממספר שמסתיים ב ${x.p.slice(-3).split('').join(' ')}, ${x.k}: ${x.q}`).join('. ') : 'אין פעילות');
    } else if (c === '4') {
      const p = await typePhone(call, 'הקישו את המספר לבדיקה, ובסיום סולמית');
      if (!p) continue;
      const s = phoneSummary(p);
      await speak(call, `המספר ${spellPhone(p)}. ${s.calls} שיחות. ${s.blocked ? 'המספר חסום' + (s.blocked.reason ? `, בגלל ${s.blocked.reason}` : '') + '.' : ''} ${s.recent.length ? `הדברים האחרונים שאמר: ${s.recent.map((x) => x.q).join('. ')}` : 'אין רישומים'}`);
      if (!s.blocked && roleOf(p) !== 'owner') {
        const b = await ask(call, 'לחסימת המספר הזה, 1. לחזרה, 0', [0, 1], { sec_wait: 6, allow_empty: true, empty_val: '0' });
        if (b === '1') {
          const dk = durKey[await ask(call, 'לכמה זמן? לשעה, 1. ליום, 2. לשבוע, 3. לחודש, 4. לצמיתות, 5', [1, 2, 3, 4, 5], { sec_wait: 8, allow_empty: true, empty_val: '2' })] || 'day';
          const reason = await listen(call, 'אמרו את סיבת החסימה. אפשר גם לשתוק', 15, 'ניהול: סיבת חסימה');
          blockPhone(p, reason, dk, call.phone);
          await speak(call, `נחסם ${durSpoken[dk]}`);
        }
      }
    } else if (c === '5') {
      const code = createAdminCode(call.phone).split('').join(', ');
      await speak(call, `הקוד שלך לאתר הניהול הוא: ${code}. אחזור: ${code}. תקף לרבע שעה. נכנסים לכתובת ${spokenSite(owner ? 'admin' : 'staff')}, ומזינים את מספר הטלפון ואת הקוד`);
    } else if (owner && c === '6') {
      const r = await ask(call, 'להוספת הוראה, 1. לשמיעת ההוראות, 2. למחיקת הוראה, 3', [1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '2' });
      const rules = listRules();
      if (r === '1') {
        const t = await listen(call, 'אמרו את ההוראה ל-AI. למשל: אל תדבר על ספורט', 25, 'ניהול: הוראה');
        if (t && addRule(t)) await speak(call, `נוספה הוראה: ${t}`);
      } else if (r === '2') {
        await speak(call, rules.length ? rules.map((x, i) => `${i + 1}, ${x.text}`).join('. ') : 'אין הוראות');
      } else if (rules.length) {
        const n = await ask(call, `${rules.slice(0, 9).map((x, i) => `למחיקת ${x.text}, ${i + 1}`).join('. ')}`, rules.slice(0, 9).map((_, i) => i + 1), { sec_wait: 10, allow_empty: true, empty_val: '0' });
        const x = rules[Number(n) - 1];
        if (x && removeRule(x.id)) await speak(call, 'ההוראה נמחקה');
      }
    } else if (owner && c === '7') {
      const r = await ask(call, 'להוספת איש צוות, 1. לשמיעת הצוות, 2. להסרת איש צוות, 3', [1, 2, 3], { sec_wait: 7, allow_empty: true, empty_val: '2' });
      if (r === '1') {
        const p = await typePhone(call, 'הקישו את המספר של איש הצוות, ובסיום סולמית');
        if (p && addStaff(p)) await speak(call, `המספר ${spellPhone(p)} נוסף לצוות הפיקוח. מעכשיו יש לו תפריט ניהול בהקשה 9`);
      } else if (r === '2') {
        const st = staffList();
        await speak(call, st.length ? st.map((x) => `${x.name ? `${x.name}, ` : ''}${spellPhone(x.phone)}`).join('. ') : 'אין עדיין צוות פיקוח');
      } else {
        const p = await typePhone(call, 'הקישו את המספר להסרה מהצוות, ובסיום סולמית');
        if (p) await speak(call, removeStaff(p) ? 'הוסר מהצוות' : 'המספר הזה לא בצוות');
      }
    } else if (owner && c === '8') {
      const t = await call.read([await say(call, `המכסה היום ${Number(getSetting('dailyLimit', 0)) || 'ללא הגבלה'}. הקישו מספר שאלות ליום למי שאינו תומך, אפס לללא הגבלה, ובסיום סולמית`)], 'tap', { min_digits: 1, max_digits: 4, sec_wait: 10, allow_empty: true, empty_val: 'X' });
      if (/^\d+$/.test(String(t))) {
        setLineSetting('dailyLimit', Number(t));
        await speak(call, Number(t) ? `נשמר: ${t} שאלות ליום` : 'נשמר: ללא הגבלה');
      }
    }
  }
}

// ---------- חיפוש וכניסה לאתרים ----------
async function webMode(call) {
  while (true) {
    const c = await ask(call, 'לחיפוש, הקישו 1. לכניסה לאתר לפי שם, 2. לפורום מתמחים טופ, 3. לקיצורים שלכם, 4. לתפריט הראשי, 0', [0, 1, 2, 3, 4], { sec_wait: 8, allow_empty: true, empty_val: '0' });
    if (c === '1') await searchMode(call);
    else if (c === '2') await siteMode(call);
    else if (c === '3') await forumMode(call, 'mitmachim.top');
    else if (c === '4') await shortcutsMode(call);
    else return;
  }
}

// ---------- התפריט הראשי ----------
function authorized(call) {
  if (cfg.key && call.req.query.key !== cfg.key) return false;
  if (cfg.allowedPhones.length && !roleOf(call.phone)) {
    const p = String(call.phone || '').replace(/\D/g, '');
    const ok = cfg.allowedPhones.some((a) => a.replace(/\D/g, '').slice(-9) === p.slice(-9) && p.length >= 9);
    if (!ok) return false;
  }
  return true;
}

function handler(call) {
  return withCaller(call.phone, () => handlerInner(call));
}

async function handlerInner(call) {
  if (!authorized(call)) {
    console.warn('שיחה לא מורשית מ', call.phone);
    return call.id_list_message([T('אין הרשאה'), { type: 'go_to_folder', data: 'hangup' }]);
  }
  const bi = blockInfo(call.phone);
  if (bi) {
    const left = bi.until ? bi.until - Date.now() : 0;
    const howLong = !bi.until ? 'לצמיתות' : left < 3600_000 * 2 ? `לעוד ${Math.max(1, Math.round(left / 60000))} דקות` : left < 86400_000 * 2 ? `לעוד ${Math.round(left / 3600_000)} שעות` : `לעוד ${Math.round(left / 86400_000)} ימים`;
    return call.id_list_message([T(`המספר שלך נחסם ${howLong}. ${bi.reason ? `הסיבה: ${bi.reason}.` : ''} להתראות`), { type: 'go_to_folder', data: 'hangup' }]);
  }
  console.log('שיחה נכנסת מ', call.phone || 'מספר חסוי');
  logAnswer(call.phone, 'שיחה התחילה', '', true);
  // ברכה קצרה שאפשר לקטוע בהקשה. נכנסים לשיחה עם העוזר רק בהקשה על 1
  let first = true;
  let silent = 0;
  while (true) {
    const nm = users.nameOf(call.phone);
    const hello = first ? `שלום${nm ? ` ${nm}` : ''}${isDonor(call.phone) ? ', ותודה שאתה מתומכי הקו' : ''}, הגעתם לעוזר החכם. השיחות נרשמות. ` : '';
    const role = roleOf(call.phone);
    const d = await ask(call, `${hello}לשיחה עם העוזר, הקישו 1. לחיפוש ואתרים, 2. למייל, 3. לאיזור האישי, 4.${role ? ' לניהול, 9.' : ''} ליציאה, 0`, role ? [0, 1, 2, 3, 4, 9] : [0, 1, 2, 3, 4], { sec_wait: 6, allow_empty: true, empty_val: 'E' });
    first = false;
    if (d === 'E') {
      if (++silent >= 3) return call.id_list_message([T('להתראות'), { type: 'go_to_folder', data: 'hangup' }]);
      continue;
    }
    silent = 0;
    if (d === '0') {
      return call.id_list_message([T('להתראות'), { type: 'go_to_folder', data: 'hangup' }]);
    }
    const fn = { 1: chatMode, 2: webMode, 3: mailMode, 4: personalMode, 9: role ? manageMode : null }[d];
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
  ['BREVO_API_KEY', 'מפתח API של Brevo לשליחת מיילי החיבור (מומלץ)'],
  ['BREVO_SENDER', 'כתובת השולח שאושרה ב-Brevo (בדרך כלל המייל שאיתו נרשמת)'],
  ['GOOGLE_CLOUD_KEY', 'מפתח API של גוגל קלאוד: קולות ברורים וזיהוי דיבור מדויק (אופציונלי)'],
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
  addHomeRoutes(app);
  addAdminRoutes(app);
  addMyRoutes(app);
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
      ? `<p>עוד צעד אחד: לאשר לקו הטלפון לקרוא ולענות להודעות בג׳ימייל שלך.</p><a class="btn" href="/auth/google?s=${encodeURIComponent(sid)}">חבר את הג׳ימייל</a><hr>`
      : '';
    const f = `<p>אפשר גם לחבר בסיסמת אפליקציה של ג׳ימייל (שש עשרה אותיות, נוצרת בהגדרות החשבון של גוגל תחת "סיסמאות אפליקציה").</p>
<form method="post" action="/connect/app"><input type="hidden" name="s" value="${esc(sid)}">
<input name="email" type="email" value="${esc(r.email)}" dir="ltr" placeholder="Gmail" required>
<input name="pass" type="password" dir="ltr" placeholder="סיסמת אפליקציה" autocomplete="off" required>
<button class="btn" type="submit">חבר</button></form>`;
    res.send(page('הטלפון חובר', `<p>הטלפון שלך חובר לכתובת ${esc(r.email)}.</p>${g}${f}`));
  });
  app.post('/connect/app', async (req, res) => {
    const sess = users.getSession(String(req.body.s || ''));
    const email = String(req.body.email || '').trim().toLowerCase();
    const pass = String(req.body.pass || '').replace(/\s/g, '').toLowerCase();
    if (!sess) return res.status(400).send(page('הפעולה לא תקפה', '<p>חזור לקישור שבמייל.</p>'));
    if (!/^[^\s@]+@(gmail|googlemail)\.com$/.test(email) || !/^[a-z]{16}$/.test(pass)) {
      return res.status(400).send(page('פרטים לא תקינים', '<p>צריך כתובת ג׳ימייל וסיסמת אפליקציה בת שש עשרה אותיות. חזור אחורה ונסה שוב.</p>'));
    }
    if (!(await mail.verifyAccount(email, pass))) return res.status(400).send(page('ההתחברות נכשלה', '<p>ג׳ימייל לא קיבל את הפרטים. בדוק ונסה שוב.</p>'));
    users.setAppPassword(sess.phone, email, pass);
    users.dropSession(String(req.body.s));
    res.send(page('הג׳ימייל חובר', '<p>הכל מוכן. אפשר לחזור לטלפון ולהקיש 3 כדי לשמוע את המייל.</p>'));
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
  // כתובת זמנית ישנה (trycloudflare) או localhost לא עובדות בקישורים במייל: עוברים לכתובת ה-IP הציבורית של השרת
  if (process.env.EXTRA_PORT && /trycloudflare|localhost/.test(cfg.baseUrl)) {
    fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }).then((r) => r.text()).then((ip) => {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip.trim())) {
        cfg.baseUrl = `http://${ip.trim()}:${process.env.EXTRA_PORT}`;
        console.log('כתובת לקישורים:', cfg.baseUrl);
      }
    }).catch(() => {});
  }
  llmWarm();
  setInterval(llmWarm, 4 * 60 * 1000).unref();
}
