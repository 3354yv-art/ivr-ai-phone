// ספקי AI בשרשרת גיבוי: מנסים לפי הסדר, ועוברים לבא כשהמכסה נגמרה או שיש תקלה.
import { cfg } from './config.js';
import { callerPhone } from './ctx.js';
import { allKeys, donorKey, isDonor } from './pool.js';
import { transcribe as sttLocal } from './local.js';

const SYSTEM = [
  'אתה עוזר אישי חכם בטלפון, שמדבר עם המתקשר כמו אדם נבון וחם, לא כמו רובוט שמדקלם. המשתמש שומע אותך בהקראה ולא קורא.',
  'דבר בעברית מדוברת וטבעית, בשפה נקייה ומכובדת. תפוס מה המתקשר באמת צריך וענה לעניין, ברור ובאורך בינוני: שלושה עד ארבעה משפטים, לא יותר, אלא אם ביקשו הרחבה או קיצור.',
  'כתוב משפטים קצרים ושלמים עם פסיקים במקומות של הפסקה טבעית, כדי שההקראה תישמע ברורה ולא רצופה. אל תחזור על השאלה, אל תפתח ב"שאלה טובה" ואל תסיים בנוסחאות קבועות. אם משהו לא ברור, שאל שאלה אחת קצרה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
].join(' ');
export { SYSTEM };

// חלוקת עומס בין המפתחות: סבב הוגן, ומפתח שקיבל "יותר מדי בקשות" (429) או נכשל
// נח בצד לזמן שגרוק ביקשה, כדי שהבקשות הבאות ילכו מיד למפתח פנוי ולא יחכו
let rr = 0;
const rest = new Map(); // key -> עד מתי לנוח
const stats = new Map(); // key -> { ok, fail, ms }
export const keyStats = () => [...stats.entries()].map(([k, v]) => ({ tail: k.slice(-4), ...v, resting: (rest.get(k) || 0) > Date.now() }));
function note(k, ok, ms) {
  const s = stats.get(k) || { ok: 0, fail: 0, ms: 0 };
  if (ok) { s.ok++; s.ms = s.ms ? Math.round(s.ms * 0.8 + ms * 0.2) : ms; } else s.fail++;
  stats.set(k, s);
}
async function withKeys(fn) {
  const all = allKeys();
  const now = Date.now();
  let keys = all.filter((k) => (rest.get(k) || 0) <= now);
  if (!keys.length) keys = all; // כולם נחים: מנסים בכל זאת
  let start = rr++ % keys.length;
  // תומך הקו: המפתח שלו משמש קודם כל אותו
  const mine = donorKey(callerPhone());
  if (mine && keys.includes(mine)) start = keys.indexOf(mine);
  let last;
  // לכל היותר 3 מפתחות לבקשה, כדי לא לעבור את זמן התגובה
  for (let i = 0; i < Math.min(keys.length, 3); i++) {
    const k = keys[(start + i) % keys.length];
    const t0 = Date.now();
    try {
      const v = await fn(k);
      note(k, true, Date.now() - t0);
      return v;
    } catch (e) {
      last = e;
      note(k, false, 0);
      const m = String(e.message).match(/try again in ([\d.]+)(ms|s|m)/i);
      const wait = m ? Number(m[1]) * ({ ms: 1, s: 1000, m: 60000 }[m[2].toLowerCase()]) : /HTTP 429/.test(e.message) ? 20000 : /HTTP 40[13]/.test(e.message) ? 3600000 : /HTTP 404/.test(e.message) ? 0 : 3000;
      rest.set(k, Date.now() + Math.min(wait + 500, 3600000));
    }
  }
  throw last;
}

// חימום חיבור: חוסך לחיצת יד TLS בשיחה הראשונה
export function warmUp() {
  if (allKeys().length) fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${allKeys()[0]}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
}

// ---- מודלי שפה ----
const cf = () => `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/ai/v1`;
const LLM = {
  groq: {
    on: () => allKeys().length > 0,
    call: (m, n) => withKeys((k) => openai('https://api.groq.com/openai/v1', k, cfg.groqModel, m, n, /gpt-oss/.test(cfg.groqModel) ? { reasoning_effort: 'low' } : {})),
  },
  cerebras: {
    on: () => !!cfg.cerebrasKey,
    call: (m, n) => openai('https://api.cerebras.ai/v1', cfg.cerebrasKey, cfg.cerebrasModel, m, n, { reasoning_effort: 'low' }),
  },
  cloudflare: {
    on: () => !!(cfg.cfAccountId && cfg.cfToken),
    call: (m, n) => openai(cf(), cfg.cfToken, cfg.cfModel, m, n),
  },
  local: { on: () => true, call: (m, n) => ollama(m, n) },
};

async function openai(base, key, model, messages, max_tokens, extra = {}, timeout = cfg.llmTimeoutMs) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens, temperature: 0.4, ...extra }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const t = ((await r.json()).choices?.[0]?.message?.content || '').trim();
  if (!t) throw new Error('empty');
  return t;
}

async function ollama(messages, num_predict) {
  const r = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.localModel, messages, stream: false, keep_alive: '24h',
      options: { num_predict, temperature: 0.4, num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  return ((await r.json()).message?.content || '').trim();
}


// "בקשה מגובה": הראשון מתחיל מיד; אם לא ענה תוך HEDGE_MS (או נכשל) מצטרף הבא במקביל. מנצח הראשון שהצליח.
async function hedged(names, run) {
  const cloud = names.filter((n) => n !== 'local');
  const useLocal = names.includes('local');
  let last;
  if (cloud.length) {
    try {
      return await new Promise((resolve, reject) => {
        let started = 0, failed = 0, done = false;
        const launch = () => {
          if (done || started >= cloud.length) return;
          const name = cloud[started++];
          run(name).then(
            (v) => { if (!done) { done = true; resolve(v); } },
            (e) => {
              last = e; console.warn(`ספק ${name} נכשל: ${e.message}`);
              if (++failed === cloud.length) reject(e); else launch();
            },
          );
          if (started < cloud.length) setTimeout(launch, cfg.hedgeMs);
        };
        launch();
      });
    } catch (e) { last = e; }
  }
  if (useLocal) {
    try { return await run('local'); } catch (e) { last = e; console.warn(`ספק local נכשל: ${e.message}`); }
  }
  throw new Error('BUSY', { cause: last });
}

// מודל של גרוק עם חיפוש אמיתי ברשת (רץ בשרתים של גרוק, לכן לא נחסם)
let searchModels = null;
export async function webAnswer(query, extraSys = '') {
  if (!allKeys().length) throw new Error('no keys');
  searchModels ||= [cfg.groqSearchModel, 'groq/compound', 'compound-beta-mini', 'compound-beta'].filter((m, i, a) => a.indexOf(m) === i);
  let last;
  for (const model of [...searchModels]) {
    try {
      return await withKeys((k) => openai('https://api.groq.com/openai/v1', k, model, [
        { role: 'system', content: SYSTEM + extraSys + ' חפש ברשת מידע עדכני וענה על סמך מה שמצאת.' },
        { role: 'user', content: query },
      ], 400, {}, cfg.searchTimeoutMs));
    } catch (e) {
      last = e;
      // מודל שלא קיים: לא מנסים אותו שוב
      if (/HTTP 404|does not exist/.test(e.message)) searchModels = searchModels.filter((m) => m !== model);
      else throw e;
    }
  }
  throw last || new Error('no search model');
}

const order = () => cfg.chain.filter((n) => LLM[n]?.on());

export async function complete(messages, max_tokens = 120) {
  if (isDonor(callerPhone())) max_tokens = Math.round(max_tokens * 1.8);
  return hedged(order(), (n) => LLM[n].call(messages, max_tokens));
}

// ---- תמלול ----
async function sttOpenaiStyle(base, key, model, wav) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'rec.wav');
  fd.append('model', model);
  fd.append('language', 'he');
  fd.append('temperature', '0');
  fd.append('prompt', 'שיחה בעברית עם עוזר טלפוני. חיפוש, שאלה, אתר, מייל, פורום מתמחים טופ.');
  fd.append('response_format', 'json');
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return String((await r.json()).text || '').trim();
}

// זיהוי דיבור של גוגל קלאוד (אם הוגדר מפתח): מדויק מאוד בעברית
async function sttGoogle(wav) {
  const r = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(cfg.googleCloudKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { languageCode: 'he-IL', enableAutomaticPunctuation: true, model: 'default' }, audio: { content: Buffer.from(wav).toString('base64') } }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`google stt ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return (j.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' ').trim();
}

const STT = {
  google: { on: () => !!cfg.googleCloudKey, call: (w) => sttGoogle(w) },
  groq: {
    on: () => allKeys().length > 0,
    call: (w) => withKeys((k) => sttOpenaiStyle('https://api.groq.com/openai/v1', k, cfg.groqSttModel, w)),
  },
  cloudflare: {
    on: () => !!(cfg.cfAccountId && cfg.cfToken),
    call: async (w) => {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/ai/run/@cf/openai/whisper-large-v3-turbo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.cfToken}` },
          body: JSON.stringify({ audio: Buffer.from(w).toString('base64'), language: 'he' }),
          signal: AbortSignal.timeout(7000),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return String((await r.json()).result?.text || '').trim();
    },
  },
  local: { on: () => true, call: (w) => sttLocal(w) },
};

export async function transcribeChain(wav) {
  const chain = cfg.googleCloudKey && !cfg.sttChain.includes('google') ? ['google', ...cfg.sttChain] : cfg.sttChain;
  return hedged(chain.filter((n) => STT[n]?.on()), (n) => STT[n].call(wav));
}
