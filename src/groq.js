// מנוע מהיר בענן (Groq, שכבה חינמית): תמלול Whisper ומודל שפה. חיפוש דרך DuckDuckGo.
import { cfg } from './config.js';
import { ddg } from './local.js';

const BASE = 'https://api.groq.com/openai/v1';

const SYSTEM = [
  'אתה עוזר קולי בטלפון. המשתמש שומע אותך בהקראה ולא קורא.',
  'ענה בעברית, בשפה נקייה ומכובדת, קצר וברור: עד שלושה משפטים אלא אם ביקשו הרחבה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
].join(' ');

function headers(extra = {}) {
  if (!cfg.groqKey) throw new Error('חסר מפתח Groq');
  return { authorization: `Bearer ${cfg.groqKey}`, ...extra };
}

async function llm(messages, max_tokens = 220) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: cfg.groqModel, messages, max_tokens, temperature: 0.4 }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return ((await r.json()).choices?.[0]?.message?.content || '').trim();
    if ((r.status === 429 || r.status >= 500) && i === 0) {
      await new Promise((res) => setTimeout(res, 800));
      continue;
    }
    throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

export async function transcribe(wav) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'rec.wav');
  fd.append('model', cfg.groqSttModel);
  fd.append('language', 'he');
  fd.append('temperature', '0');
  fd.append('response_format', 'json');
  const r = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: headers(),
    body: fd,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String((await r.json()).text || '').trim();
}

export async function chat(history, userText) {
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-10).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: userText },
  ];
  return (await llm(messages)) || 'לא הצלחתי לענות על זה';
}

export async function search(query) {
  const results = await ddg(query);
  if (!results.length) return { answer: 'לא מצאתי תוצאות', sources: [] };
  const ctx = results.map((x, i) => `${i + 1}. ${x.title}. ${x.snippet}`).join('\n');
  const answer = await llm([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `שאלה: ${query}\n\nתוצאות חיפוש:\n${ctx}\n\nענה בקצרה על סמך התוצאות.` },
  ]);
  return { answer: answer || 'לא מצאתי תשובה', sources: results.map((x) => ({ title: x.title, url: x.url })) };
}

export async function findSite(spoken) {
  const direct = String(spoken).trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(direct)) return `https://${direct}`;
  const results = await ddg(`${spoken} אתר רשמי`);
  return results[0]?.url || null;
}

export async function summarize(text) {
  const out = await llm([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `סכם בקצרה, עד ארבעה משפטים, את הטקסט הבא מדף אינטרנט:\n\n${text.slice(0, 8000)}` },
  ], 250);
  return out || 'לא הצלחתי לסכם';
}
