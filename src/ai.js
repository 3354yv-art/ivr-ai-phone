// נקודת הכניסה ל-AI. כברירת מחדל: שרשרת גיבוי של ספקים (Groq, Cerebras, Cloudflare, מקומי).
// AI_PROVIDER=gemini מפעיל את Gemini בלבד. במצב בדיקה (MOCK) נשאר המדמה.
import * as gemini from './gemini.js';
import { ddg, wiki } from './local.js';
import { cfg } from './config.js';
import { fetchPage } from './web.js';
import { SYSTEM as BASE, complete, transcribeChain, webAnswer } from './llm.js';
import { rulesPrompt, listRules } from './rules.js';
import { callerPhone } from './ctx.js';
import { isDonor } from './pool.js';
import { getSettings } from './users.js';
import { roleOf } from './admin.js';
const rp = () => rulesPrompt(roleOf(callerPhone()));

// ההנחיה הבסיסית + הוראות המנהל (מתעדכן מיד כשהמנהל משנה)
const LEN = { short: ' המתקשר ביקש תשובות קצרות: משפט או שניים.', long: ' המתקשר ביקש תשובות מפורטות: עד שמונה משפטים.' };
const sys = (persona = '') => BASE + (LEN[getSettings(callerPhone()).length] || '') + (isDonor(callerPhone()) ? ' המתקשר הוא מתומכי הקו: כשזה מועיל, אפשר לענות בהרחבה ובפירוט רב יותר, עד חמישה משפטים.' : '') + (persona ? ` מידע והעדפות שהמתקשר ביקש שתזכור ותתאים אליהם את התשובות (אלא אם הם סותרים את הוראות המנהל): ${persona}.` : '') + rp();

// מחכה עד ms; אם לא הסתיים מחזיר fallback (בלי לבטל)
const within = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
const cache = new Map();
const cached = (k) => { const c = cache.get(k); return c && Date.now() - c.t < 10 * 60_000 ? c.v : null; };
const remember = (k, v) => { cache.set(k, { t: Date.now(), v }); if (cache.size > 300) cache.delete(cache.keys().next().value); };

const legacy = cfg.mock || cfg.aiProvider === 'gemini';

export async function transcribe(wav) {
  return legacy ? gemini.transcribe(wav) : transcribeChain(wav);
}

// שיחה חופשית עם העוזר. העוזר יכול גם לבקש לבצע פעולה: אז הוא מחזיר שורה אחת שמתחילה ב-@@ ואחריה JSON
const ACTIONS = ` אתה גם יכול לבצע פעולות בשביל המתקשר. כשהוא מבקש אחת מהן, אל תענה במילים אלא החזר רק שורה אחת: @@ ואחריה JSON:
@@{"action":"search","query":"...","enter":false} - (enter:true רק אם ביקש במפורש גם להיכנס לתוצאה, למשל "תחפש ותכנס לשם"; אחרת false, ואל תיכנס לשום אתר מעצמך) - כשביקש לחפש, כשהשאלה צריכה מידע עדכני (חדשות, מחירים, שעות פתיחה, מזג אוויר, אירועים), וגם בכל שאלה על אדם מסוים, מקום, ארגון, מוצר, אתר, ספר, שיר או אירוע, אלא אם אתה בטוח לגמרי בתשובה. לעולם אל תמציא פרטים על אנשים או דברים שאינך בטוח בהם - חפש
@@{"action":"site","name":"שם האתר"} - כשביקש להיכנס לאתר
@@{"action":"forum"} - רק כשביקש במפורש להיכנס לפורום מתמחים טופ, לקרוא בו, להגיב או לראות צ'אטים. "תחפש מתמחים טופ" זה חיפוש בלבד ולא כניסה
@@{"action":"mail"} - כשביקש לשמוע או לשלוח מייל
@@{"action":"remember","text":"..."} - כשביקש שתזכור משהו עליו
@@{"action":"calendar","date":"YYYY-MM-DD"} - כשביקש לדעת מה יש לו ביומן (היום, מחר, יום מסוים)
@@{"action":"add_event","title":"...","start":"YYYY-MM-DDTHH:MM:00+02:00","end":"..."} - כשביקש לקבוע משהו ביומן
@@{"action":"drive","query":"שם הקובץ"} - כשביקש קובץ או מסמך מהדרייב שלו
@@{"action":"contacts","query":"שם"} - כשביקש מספר טלפון של איש קשר מהחשבון שלו
@@{"action":"tasks"} - כשביקש לשמוע את רשימת המשימות שלו
@@{"action":"add_task","title":"..."} - כשביקש להוסיף משימה
@@{"action":"files","kind":"slides|forms|sheets|docs","query":"חלק משם, או ריק"} - כשביקש לשמוע אילו מצגות, טפסים, גיליונות או מסמכים יש לו (לפי סוג, אפשר עם שם)
@@{"action":"youtube_mine","what":"playlists|subscriptions"} - כשביקש לשמוע את רשימות ההשמעה או הערוצים שהוא עוקב אחריהם ביוטיוב
@@{"action":"settings"} - כשביקש לשנות קול, מהירות או אורך תשובות
@@{"action":"menu"} - כשביקש לחזור לתפריט, לצאת, או סיים ("די", "תודה, זהו", "ביי")
בכל מקרה אחר ענה כרגיל, בלי @@.`;

const nowLine = () => ` עכשיו ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (שעון ישראל).`;

// כשהחיפוש ברשת בכל שאלה פעיל: כמעט כל שאלה הופכת לחיפוש, עם שאילתה שלמה שכוללת את ההקשר מהשיחה
const ALWAYS = ` המתקשר ביקש שתחפש ברשת בכל שאלה של מידע. לכן על כל שאלה או בקשה למידע כללי החזר @@{"action":"search","query":"..."}, כשהשאילתה שלמה ועומדת בפני עצמה (השלם מההקשר של השיחה, למשל "ומה עם אחיו?" -> שם האח המלא). חשוב: פעולות אחרות קודמות לחיפוש. בקשה על היומן, המשימות, אנשי הקשר, הקבצים, המייל, כניסה לאתר, הפורום, הגדרות, זיכרון, או חזרה לתפריט - מבצעים בפעולה המתאימה ולא מחפשים. ענה בלי חיפוש על ברכות, תודות ושיחת חולין קצרה.`;

export async function chat(history, userText, persona = '', withActions = false, alwaysSearch = false) {
  if (legacy) {
    if (withActions) {
      const c = String(userText);
      if (/^(די|יציאה|תפריט|ביי)/.test(c)) return { action: 'menu' };
      if (/^תחפש /.test(c)) return { action: 'search', query: c.slice(5) };
      if (/מתמחים/.test(c)) return { action: 'forum' };
      const at = c.match(/^תוסיף משימה\s*(.+)/);
      if (at) return { action: 'add_task', title: at[1].trim() };
      if (/משימות/.test(c)) return { action: 'tasks' };
      const ct = c.match(/המספר של\s*(.+)/);
      if (ct) return { action: 'contacts', query: ct[1].trim() };
      const fl = c.match(/אילו (מצגות|טפסים|גיליונות|מסמכים)/);
      if (fl) return { action: 'files', kind: { מצגות: 'slides', טפסים: 'forms', גיליונות: 'sheets', מסמכים: 'docs' }[fl[1]], query: '' };
      if (/רשימות השמעה/.test(c)) return { action: 'youtube_mine', what: 'playlists' };
      const rm = c.match(/^תזכור\s*ש?(.+)/);
      if (rm) return { action: 'remember', text: rm[1].trim() };
      if (alwaysSearch && !/^(שלום|תודה)/.test(c)) {
        if (globalThis.__mockDelay) await new Promise((r) => setTimeout(r, globalThis.__mockDelay));
        return { action: 'search', query: c };
      }
    }
    const t = await gemini.chat(history, userText);
    return withActions ? { text: t } : t;
  }
  const messages = [
    { role: 'system', content: sys(persona) + nowLine() + (withActions ? ACTIONS + (alwaysSearch ? ALWAYS : '') : '') },
    ...history.slice(-10).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: userText },
  ];
  const out = (await complete(messages, 320)) || 'לא הצלחתי לענות על זה';
  if (!withActions) return out;
  const m = String(out).match(/@@\s*(\{[\s\S]*\})/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* לא JSON תקין: מתייחסים כתשובה */
    }
  }
  return { text: String(out).replace(/@@.*$/s, '').trim() || 'לא הצלחתי לענות על זה' };
}

// מתקן שאילתת חיפוש שהגיעה מזיהוי דיבור: מילים משובשות או חסרות -> השאילתה שהמתקשר כנראה התכוון אליה
export async function fixQuery(q) {
  if (legacy || String(q).length < 3) return q;
  try {
    const out = await complete([
      { role: 'system', content: 'אתה מקבל טקסט מזיהוי דיבור בעברית שעלול להכיל מילים משובשות, חסרות או דומות בצליל. החזר רק את מה שהדובר כנראה התכוון לומר, מתוקן ושלם, כשאילתת חיפוש קצרה. בלי הסברים, בלי מרכאות. אם הטקסט תקין, החזר אותו כמו שהוא. אל תשנה שמות פרטיים, שמות של אנשים ושמות של אתרים. שמות שכדאי להכיר: מתמחים טופ (פורום), ימות המשיח, נטפרי, גוגל, יוטיוב.' },
      { role: 'user', content: String(q) },
    ], 60);
    const f = String(out || '').trim().replace(/^["'״]+|["'״]+$/g, '');
    return f && f.length < 200 ? f : q;
  } catch {
    return q;
  }
}

// חיפוש: ויקיפדיה ומנועי חיפוש במקביל; אם אין תוצאות - חיפוש ברשת דרך גרוק; ולבסוף ידע המודל.
// תשובות זהות נשמרות 10 דקות כדי לענות מיד.
// מנוע חיפוש מקומי (SearXNG) שרץ על השרת ומשלב כמה מנועי חיפוש. בכשל חוזרים לחיפוש הרגיל, ומנסים שוב אחרי דקה
let searxBlockedUntil = 0;
async function searxSearch(query) {
  const u = `${cfg.searxUrl}/search?format=json&language=he&safesearch=1&q=${encodeURIComponent(query)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(3500) });
  if (!r.ok) throw new Error(`searx ${r.status}`);
  const j = await r.json();
  return (j.results || []).slice(0, 6).map((x) => ({ title: x.title || '', url: x.url || '', snippet: x.content || '' })).filter((x) => x.title);
}

export async function search(query, persona = '') {
  if (legacy) return gemini.search(query);
  const key = `${query}|${persona}`.trim().toLowerCase();
  const hit = cached(key);
  if (hit) return hit;
  let google = [];
  if (cfg.searxUrl && Date.now() >= searxBlockedUntil) {
    try {
      google = await searxSearch(query);
      if (!google.length) searxBlockedUntil = Date.now() + 15000;
    } catch {
      searxBlockedUntil = Date.now() + 60000;
    }
  }
  const [web, wk] = google.length ? [[], []] : await Promise.all([within(ddg(query), 1800, []), within(wiki(query), 1800, [])]);
  const results = google.length ? google : [...web.slice(0, 4), ...wk.slice(0, 2)];
  let out;
  if (results.length) {
    // כשהקטעים קצרים: מביאים גם את תחילת התוכן של שתי התוצאות הראשונות (עד שתי שניות), כדי שהתשובה תהיה מדויקת יותר
    const thin = results.reduce((n, x) => n + x.snippet.length, 0) < 900;
    const extra = thin && google.length ? await Promise.all(results.slice(0, 2).map((x) => within(fetchPage(x.url).then((p) => p.text.replace(/\s+/g, ' ').slice(0, 1200)), 2000, ''))) : [];
    const ctx = results.map((x, i) => `${i + 1}. ${x.title} (${(() => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return ''; } })()}). ${x.snippet.slice(0, 500)}${extra[i] ? ` תוכן מהדף: ${extra[i]}` : ''}`).join('\n');
    const answer = await complete([
      { role: 'system', content: sys(persona) },
      { role: 'user', content: `שאלה: ${query}\n\nתוצאות חיפוש:\n${ctx}\n\nהתחל בתשובה הישירה לשאלה במשפט הראשון. ענה רק על סמך התוצאות, בלי להוסיף פרטים שלא מופיעים בהן. כשהמידע עלול להשתנות או שהמקור חשוב, ציין בקצרה את שם האתר, למשל 'לפי ויקיפדיה'. היום הוא ${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}. אם התוצאות לא עונות על השאלה, אמור בכנות שלא מצאת מידע ברור. אם הן לא עונות על השאלה, ענה מהידע שלך.` },
    ], 220);
    out = { answer: answer || 'לא מצאתי תשובה', sources: results.map((x) => ({ title: x.title, url: x.url })) };
  } else {
    // אין תוצאות: חיפוש אמיתי ברשת דרך גרוק, ובמקביל תשובה מהידע של המודל כגיבוי מהיר
    const know = complete([{ role: 'system', content: sys(persona) }, { role: 'user', content: `ענה על: ${query}\nאם אינך בטוח בתשובה, אמור בכנות שאינך יודע, ואל תמציא.` }], 320).catch(() => '');
    const live = await within(webAnswer(query, sys(persona).slice(BASE.length)), 4500, '');
    out = { answer: live || (await know) || 'לא מצאתי תוצאות', sources: [] };
  }
  remember(key, out);
  return out;
}

export async function findSite(spoken) {
  if (legacy) return gemini.findSite(spoken);
  const direct = String(spoken).trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(direct)) return `https://${direct}`;
  const results = await ddg(`${spoken} אתר רשמי`);
  return results[0]?.url || null;
}

export async function summarize(text) {
  if (legacy) return gemini.summarize(text);
  const out = await complete([
    { role: 'system', content: sys() },
    { role: 'user', content: `סכם בקצרה, עד ארבעה משפטים, את הטקסט הבא מדף אינטרנט:\n\n${text.slice(0, 8000)}` },
  ], 200);
  return out || 'לא הצלחתי לסכם';
}

const parseJson = (out) => {
  try {
    return JSON.parse(String(out).match(/\{[\s\S]*\}/)[0]);
  } catch {
    return null;
  }
};
const histText = (h) => (h || []).slice(-6).map((x) => `${x.role === 'user' ? 'המתקשר' : 'העוזר'}: ${x.text}`).join('\n');

// סקירה קולית של דף שנפתח: מה זה הדף ומה יש בו, כמו שעוזר אנושי היה מספר, ושאלה מה לעשות
export async function pageGuide(page, persona = '') {
  if (legacy) return `נפתח הדף ${page.title}`;
  const links = (page.allLinks || page.links || []).slice(0, 25).map((l) => l.text).join(' | ');
  const out = await complete([
    { role: 'system', content: sys(persona) },
    { role: 'user', content: `פתחת עבור המתקשר דף אינטרנט. ספר לו בשתיים שלוש משפטים מדוברים מה הדף ומה הדברים העיקריים שיש בו (למשל הנושאים או הכותרות הבולטות), ואז שאל אותו בקצרה מה הוא רוצה: לשמוע משהו מסוים, להיכנס למשהו, או סיכום. אל תקריא את כל הדף.\n\nכותרת: ${page.title}\nתוכן: ${page.text.slice(0, 2500)}\nקישורים בולטים: ${links}` },
  ], 220);
  return out || `נפתח הדף ${page.title}. מה תרצה לעשות?`;
}

// סוכן הדף: מבין פקודה חופשית בעברית ומחליט מה לעשות בדף. זוכר את השיחה בדף.
// פועל על הטקסט והקישורים של הדף (לא לוחץ על כפתורים שדורשים הרצת קוד).
export async function agent(page, command, history = [], persona = '') {
  if (legacy) {
    const c = String(command);
    if (/חזור|צא/.test(c)) return { action: 'back' };
    if (/סכם|סיכום/.test(c)) return { action: 'summary' };
    if (/תקריא/.test(c)) return { action: 'read' };
    const l = (page.allLinks || page.links || [])[0];
    if (/תיכנס|תפתח/.test(c) && l) return { action: 'open', url: l.url, title: l.text };
    return { action: 'answer', text: 'הסוכן לא זמין במצב בדיקה' };
  }
  const links = (page.allLinks || page.links || []).map((l, i) => `${i + 1}. ${l.text}`).join('\n');
  const out = await complete([
    { role: 'system', content: `אתה עוזר חכם שמפעיל דף אינטרנט עבור מתקשר בטלפון. הבן מה הוא רוצה גם אם ניסח בחופשיות או בקיצור, לפי הקשר השיחה. החזר JSON בלבד באחד הפורמטים:
{"action":"open","index":מספר} - להיכנס לקישור מהרשימה שהכי מתאים למה שביקש (גם אם אמר רק חלק מהשם, או "הראשון", "האחרון", "זה על X")
{"action":"read","from":"מילים מהמקום בדף שממנו להתחיל, או ריק מההתחלה"} - כשביקש שתקריא את הדף או חלק ממנו
{"action":"answer","text":"תשובה מדוברת וקצרה"} - לשאלה על הדף, לבקשה לפרט מה יש בדף, או כשצריך לשאול אותו שאלת הבהרה
{"action":"summary"} - כשביקש סיכום
{"action":"back"} - כשביקש לחזור אחורה או לצאת מהדף
{"action":"search","query":"..."} - כשביקש לחפש משהו אחר ברשת${page.interactive ? `
{"action":"click","index":מספר} - ללחוץ על כפתור, קישור או רכיב מהרשימה (למשל "תלחץ על הוסף לסל", "תיכנס להתחברות")
{"action":"fill","index":מספר שדה,"text":"מה לכתוב","submit":true/false} - לכתוב בשדה (למשל חיפוש באתר), ו-submit true כדי לשלוח אחרי הכתיבה` : ''}
אם אין בדף מה שביקש, החזר answer שמסביר בקצרה מה כן יש.` + rp() + (persona ? ` על המתקשר: ${persona}` : '') },
    { role: 'user', content: `כותרת הדף: ${page.title}\nתוכן הדף: ${page.text.slice(0, 3500)}\n\nקישורים:\n${links}\n\nהשיחה עד עכשיו:\n${histText(history)}\n\nהמתקשר אמר עכשיו: ${command}` },
  ], 220);
  const j = parseJson(out);
  if (!j) return { action: 'answer', text: out ? String(out).slice(0, 400) : 'לא הבנתי, אפשר לומר במילים אחרות?' };
  if (page.interactive && (j.action === 'click' || j.action === 'open')) return { action: 'click', index: Number(j.index), title: (page.allLinks || [])[Number(j.index) - 1]?.text || '' };
  if (page.interactive && j.action === 'fill') return { action: 'fill', index: Number(j.index), text: String(j.text || ''), submit: !!j.submit };
  if (j.action === 'open') {
    const l = (page.allLinks || page.links)[Number(j.index) - 1];
    return l ? { action: 'open', url: l.url, title: l.text } : { action: 'answer', text: 'לא מצאתי קישור כזה בדף' };
  }
  return ['back', 'summary', 'read', 'answer', 'search'].includes(j.action) ? j : { action: 'answer', text: 'לא הבנתי, אפשר לומר במילים אחרות?' };
}

// סוכן הפורום: מבין בקשה חופשית ומחזיר פעולה בפורום
export async function forumAgent(state, command, history = [], persona = '') {
  if (legacy) {
    const c = String(command);
    if (/צ׳?'?אט|הודעות פרטיות/.test(c)) return { action: 'chats' };
    if (/תגיב|תכתוב תגובה/.test(c)) return { action: 'reply', text: c.replace(/^.*?(?:תגיב|תכתוב תגובה)\s*(ש)?/, '') || c };
    if (/^(?:תפתח|תיכנס ל)(?:\s*נושא)?\s*(\d+)/.test(c)) return { action: 'open', index: Number(c.match(/(\d+)/)[1]) };
    return { action: 'recent' };
  }
  const list = (state.list || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
  const out = await complete([
    { role: 'system', content: `אתה עוזר חכם שמפעיל עבור מתקשר בטלפון את החשבון שלו בפורום "${state.forum}". הבן מה הוא רוצה גם אם ניסח בחופשיות, לפי ההקשר. החזר JSON בלבד באחד הפורמטים:
{"action":"recent"} נושאים אחרונים | {"action":"unread"} נושאים שלא נקראו | {"action":"popular"} נושאים חמים
{"action":"open","index":מספר} לפתוח פריט מהרשימה שמוצגת עכשיו (נושא או צ'אט) - בחר את המתאים לפי מה שאמר
{"action":"more"} להמשיך להקריא עוד הודעות בנושא הפתוח | {"action":"summary"} לסכם את הנושא הפתוח
{"action":"reply","text":"תוכן התגובה"} להגיב בנושא הפתוח. אם ביקש שתנסח בשבילו, נסח תגובה טובה ועניינית בגוף ראשון בשמו, בסגנון של כתיבה בפורום, בלי אימוג׳י
{"action":"new_topic","category":"שם קטגוריה","title":"כותרת","text":"תוכן"} לפתוח נושא חדש. נסח כותרת ותוכן טובים לפי מה שביקש
{"action":"chats"} רשימת הצ'אטים | {"action":"send_chat","text":"..."} לשלוח הודעה בצ'אט הפתוח
{"action":"notifications"} התראות | {"action":"search","query":"..."} חיפוש בפורום
{"action":"answer","text":"..."} תשובה או שאלת הבהרה קצרה | {"action":"exit"} לצאת מהפורום` + rp() + (persona ? ` על המתקשר: ${persona}` : '') },
    { role: 'user', content: `מצב נוכחי: ${state.where}\n${state.detail ? `תוכן פתוח: ${state.detail.slice(0, 2500)}\n` : ''}רשימה מוצגת:\n${list || 'אין'}\n\nהשיחה עד עכשיו:\n${histText(history)}\n\nהמתקשר אמר עכשיו: ${command}` },
  ], 450);
  return parseJson(out) || { action: 'answer', text: 'לא הבנתי, אפשר לומר במילים אחרות?' };
}

// הופך רשימה או שרשור לסקירה מדוברת וטבעית
export async function narrate(instruction, data, persona = '') {
  if (legacy) return String(data).slice(0, 300);
  const out = await complete([
    { role: 'system', content: sys(persona) },
    { role: 'user', content: `${instruction}\n\n${String(data).slice(0, 5000)}` },
  ], 350);
  return out || String(data).slice(0, 400);
}

// שיחה של מנהל הקו עם ה-AI באתר הניהול. ה-AI יכול להוסיף או להסיר הוראות לקו.
// מחזיר { reply, add: [טקסטים], remove: [מזהים] }
export async function adminChat(history, text, context = '') {
  const rules = listRules();
  if (legacy) {
    const m = String(text).match(/^(?:הוראה|כלל)[:\s]+(.+)$/);
    return { reply: m ? 'הבנתי, הוספתי את ההוראה' : 'הבנתי', add: m ? [m[1]] : [], remove: [] };
  }
  const sysAdmin = [
    'אתה העוזר של מנהל קו טלפון עם בינה מלאכותית. אתה מדבר עם המנהל עצמו באתר הניהול, בעברית, בשפה נקייה ומכובדת.',
    'המנהל יכול לתת לך הוראות לקו: על מה ה-AI בקו ידבר ועל מה לא, באיזה סגנון לענות וכו׳. כשהוא נותן הוראה כזו, הוסף אותה כהוראה קצרה וברורה בגוף שני (למשל: "אל תדבר על ספורט").',
    'כשהוא מבקש לבטל הוראה, הסר אותה לפי המזהה שלה. אם לא ברור לאיזו הוראה הוא מתכוון, שאל.',
    'אפשר גם לענות על שאלות על מה שקורה בקו לפי הנתונים שמצורפים.',
    'החזר JSON בלבד, בלי שום טקסט מסביב: {"reply":"תשובה למנהל","add":["הוראה חדשה"],"remove":["מזהה"]}. add ו-remove ריקים אם אין שינוי.',
    `ההוראות הנוכחיות בקו: ${rules.length ? rules.map((r) => `[${r.id}] ${r.text}`).join(' | ') : 'אין'}.`,
    context ? `נתונים על הקו: ${context}` : '',
  ].join(' ');
  const out = await complete([
    { role: 'system', content: sysAdmin },
    ...history.slice(-12).map((m) => ({ role: m.role === 'admin' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: text },
  ], 500);
  try {
    const j = JSON.parse(String(out).match(/\{[\s\S]*\}/)[0]);
    return {
      reply: String(j.reply || 'בוצע'),
      add: Array.isArray(j.add) ? j.add.map(String).filter(Boolean).slice(0, 5) : [],
      remove: Array.isArray(j.remove) ? j.remove.map(String) : [],
    };
  } catch {
    return { reply: out ? String(out).replace(/[{}"]/g, '').slice(0, 1500) : 'לא הצלחתי לענות כרגע, נסה שוב', add: [], remove: [] };
  }
}
