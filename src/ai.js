// נקודת הכניסה ל-AI. כברירת מחדל: שרשרת גיבוי של ספקים (Groq, Cerebras, Cloudflare, מקומי).
// AI_PROVIDER=gemini מפעיל את Gemini בלבד. במצב בדיקה (MOCK) נשאר המדמה.
import * as gemini from './gemini.js';
import { ddg } from './local.js';
import { cfg } from './config.js';
import { SYSTEM, complete, transcribeChain } from './llm.js';

const legacy = cfg.mock || cfg.aiProvider === 'gemini';

export async function transcribe(wav) {
  return legacy ? gemini.transcribe(wav) : transcribeChain(wav);
}

export async function chat(history, userText) {
  if (legacy) return gemini.chat(history, userText);
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-10).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: userText },
  ];
  return (await complete(messages)) || 'לא הצלחתי לענות על זה';
}

export async function search(query) {
  if (legacy) return gemini.search(query);
  const results = await ddg(query);
  if (!results.length) {
    // אין תוצאות מהרשת: עונים מהידע של המודל
    const a = await complete([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ענה בקצרה על: ${query}` },
    ]);
    return { answer: a || 'לא מצאתי תוצאות', sources: [] };
  }
  const ctx = results.map((x, i) => `${i + 1}. ${x.title}. ${x.snippet}`).join('\n');
  const answer = await complete([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `שאלה: ${query}\n\nתוצאות חיפוש:\n${ctx}\n\nענה בקצרה על סמך התוצאות.` },
  ]);
  return { answer: answer || 'לא מצאתי תשובה', sources: results.map((x) => ({ title: x.title, url: x.url })) };
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
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `סכם בקצרה, עד ארבעה משפטים, את הטקסט הבא מדף אינטרנט:\n\n${text.slice(0, 8000)}` },
  ], 200);
  return out || 'לא הצלחתי לסכם';
}

// סוכן הדף: מתרגם פקודה בעברית לפעולה על הדף שהמתקשר נמצא בו.
// פועל על הטקסט והקישורים של הדף (לא לוחץ על כפתורי אתר שדורשים הרצת קוד).
export async function agent(page, command) {
  if (legacy) return { action: 'answer', text: 'הסוכן לא זמין במצב בדיקה' };
  const links = (page.allLinks || page.links || []).map((l, i) => `${i + 1}. ${l.text}`).join('\n');
  const out = await complete([
    { role: 'system', content: 'אתה סוכן שמפעיל דף אינטרנט עבור מתקשר בטלפון. החזר JSON בלבד, בלי הסברים, באחד הפורמטים: {"action":"open","index":מספר קישור} לפתיחת קישור מהרשימה, {"action":"back"} לחזרה אחורה, {"action":"summary"} לסיכום הדף, {"action":"read"} להקראה מחדש, {"action":"answer","text":"תשובה קצרה בעברית על סמך תוכן הדף"} לשאלה על הדף, {"action":"unknown"} אם הבקשה לא ברורה או לא אפשרית.' },
    { role: 'user', content: `כותרת הדף: ${page.title}\nתוכן הדף: ${page.text.slice(0, 3000)}\n\nקישורים:\n${links}\n\nפקודת המתקשר: ${command}` },
  ], 160);
  try {
    const j = JSON.parse(String(out).match(/\{[\s\S]*\}/)[0]);
    if (j.action === 'open') {
      const l = (page.allLinks || page.links)[Number(j.index) - 1];
      return l ? { action: 'open', url: l.url, title: l.text } : { action: 'unknown' };
    }
    return ['back', 'summary', 'read', 'answer'].includes(j.action) ? j : { action: 'unknown' };
  } catch {
    return { action: 'unknown' };
  }
}
