import { cfg } from './config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

const SYSTEM = [
  'אתה עוזר קולי בטלפון. המשתמש שומע אותך בהקראה ולא קורא.',
  'ענה בעברית, בשפה נקייה ומכובדת, קצר וברור: עד ארבעה משפטים אלא אם ביקשו הרחבה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
  'כתוב מספרים ותאריכים במילים כשזה עוזר להקראה.',
].join(' ');

async function generate(body, tries = 2) {
  if (!cfg.geminiKey) throw new Error('חסר מפתח Gemini');
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${BASE}${cfg.geminiModel}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      await new Promise((res) => setTimeout(res, 1500));
      continue;
    }
    throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

const textOf = (j) =>
  (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();

// תמלול הקלטה (wav) לעברית. אין כאן עלות יחידות בימות המשיח.
export async function transcribe(wav) {
  if (cfg.mock) return (globalThis.__mockSpeech || []).shift() ?? '';
  const j = await generate({
    contents: [{
      role: 'user',
      parts: [
        { text: 'תמלל במדויק את הדיבור בהקלטה. החזר רק את הטקסט שנאמר, בלי הסברים ובלי סימני ציטוט. אם אין דיבור ברור החזר מילה אחת: שקט' },
        { inline_data: { mime_type: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
      ],
    }],
  });
  const t = textOf(j);
  return t === 'שקט' ? '' : t;
}

// צ'אט רגיל עם זיכרון לאורך השיחה. history = [{role:'user'|'model', text}]
export async function chat(history, userText) {
  if (cfg.mock) {
    if (globalThis.__mockDelay) await new Promise((r) => setTimeout(r, globalThis.__mockDelay));
    return `תשובה לדוגמה על ${userText}`;
  }
  const contents = [...history, { role: 'user', text: userText }].map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));
  const j = await generate({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents });
  return textOf(j) || 'לא הצלחתי לענות על זה';
}

// חיפוש בגוגל (Grounding) - מחזיר תשובה קצרה ורשימת אתרים
export async function search(query) {
  if (cfg.mock) {
    return {
      answer: `מצאתי מידע על ${query}. אבטיח הוא פרי קיץ מרווה ומתוק.`,
      sources: [
        { title: 'אתר דוגמה ראשון', url: 'https://example.com/1' },
        { title: 'אתר דוגמה שני', url: 'https://example.com/2' },
      ],
    };
  }
  const j = await generate({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
  });
  const chunks = j?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    const url = c.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: c.web?.title || 'אתר', url });
    if (sources.length >= 5) break;
  }
  return { answer: textOf(j) || 'לא מצאתי תשובה', sources };
}

// מוצא כתובת אתר לפי שם שנאמר ("מתמחים טופ", "ynet")
export async function findSite(spoken) {
  const direct = String(spoken).trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(direct)) return `https://${direct}`;
  if (cfg.mock) return 'https://example.com/';
  const j = await generate({
    contents: [{
      role: 'user',
      parts: [{ text: `מהי כתובת האתר הרשמית של: ${spoken}. החזר רק את הכתובת המלאה (https://...) ושום דבר אחר.` }],
    }],
    tools: [{ google_search: {} }],
  });
  const m = textOf(j).match(/https?:\/\/[^\s,)"'<>]+/);
  return m ? m[0] : null;
}

export async function summarize(text) {
  if (cfg.mock) return 'סיכום לדוגמה של הדף';
  const j = await generate({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [{ text: `סכם בקצרה, עד חמישה משפטים, את הטקסט הבא מדף אינטרנט:\n\n${text.slice(0, 20000)}` }],
    }],
  });
  return textOf(j) || 'לא הצלחתי לסכם';
}
