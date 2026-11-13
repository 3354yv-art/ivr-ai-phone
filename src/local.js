// מנוע מקומי: מודל שפה דרך Ollama, תמלול דרך שרת Whisper מקומי, חיפוש דרך DuckDuckGo.
// אותו ממשק כמו gemini.js, כך ששאר הקוד לא משתנה.
import { JSDOM } from 'jsdom';
import { cfg } from './config.js';

const SYSTEM = [
  'אתה עוזר קולי בטלפון. המשתמש שומע אותך בהקראה ולא קורא.',
  'ענה בעברית, בשפה נקייה ומכובדת, קצר וברור: עד שלושה משפטים אלא אם ביקשו הרחבה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
].join(' ');

async function llm(messages, num_predict = 160) {
  const r = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.localModel,
      messages,
      stream: false,
      keep_alive: '24h',
      options: { num_predict, temperature: 0.4, num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.message?.content || '').trim();
}

export async function transcribe(wav) {
  const r = await fetch(`${cfg.sttUrl}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`STT ${r.status}`);
  const j = await r.json();
  return String(j.text || '').trim();
}

export async function chat(history, userText) {
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-8).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: userText },
  ];
  return (await llm(messages)) || 'לא הצלחתי לענות על זה';
}

// חיפוש ברשת בלי מפתח: דף HTML של DuckDuckGo
async function ddg(query) {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    },
    body: new URLSearchParams({ q: query, kl: 'il-he' }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const doc = new JSDOM(await r.text()).window.document;
  const out = [];
  for (const el of doc.querySelectorAll('.result')) {
    const a = el.querySelector('a.result__a');
    if (!a || el.classList.contains('result--ad')) continue;
    let url = a.getAttribute('href') || '';
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url)) continue;
    out.push({
      title: a.textContent.trim(),
      url,
      snippet: (el.querySelector('.result__snippet')?.textContent || '').trim(),
    });
    if (out.length >= 5) break;
  }
  return out;
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
    { role: 'user', content: `סכם בקצרה, עד ארבעה משפטים, את הטקסט הבא מדף אינטרנט:\n\n${text.slice(0, 5000)}` },
  ], 200);
  return out || 'לא הצלחתי לסכם';
}
