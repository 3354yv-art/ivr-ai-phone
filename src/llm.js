// ספקי AI בשרשרת גיבוי: מנסים לפי הסדר, ועוברים לבא כשהמכסה נגמרה או שיש תקלה.
import { cfg } from './config.js';
import { allKeys } from './pool.js';
import { transcribe as sttLocal } from './local.js';

const SYSTEM = [
  'אתה עוזר קולי בטלפון. המשתמש שומע אותך בהקראה ולא קורא.',
  'ענה בעברית, בשפה נקייה ומכובדת, קצר וברור: עד שני משפטים קצרים אלא אם ביקשו הרחבה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
].join(' ');
export { SYSTEM };

// כמה מפתחות לאותו ספק: מחלקים עומס בסבב, ובכישלון מנסים את הבא
let rr = 0;
async function withKeys(fn) {
  const keys = allKeys();
  const start = rr++ % keys.length;
  let last;
  for (let i = 0; i < keys.length; i++) {
    try { return await fn(keys[(start + i) % keys.length]); } catch (e) { last = e; }
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

async function openai(base, key, model, messages, max_tokens, extra = {}) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens, temperature: 0.4, ...extra }),
    signal: AbortSignal.timeout(5000),
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

const order = () => cfg.chain.filter((n) => LLM[n]?.on());

export async function complete(messages, max_tokens = 120) {
  return hedged(order(), (n) => LLM[n].call(messages, max_tokens));
}

// ---- תמלול ----
async function sttOpenaiStyle(base, key, model, wav) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'rec.wav');
  fd.append('model', model);
  fd.append('language', 'he');
  fd.append('temperature', '0');
  fd.append('response_format', 'json');
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return String((await r.json()).text || '').trim();
}

const STT = {
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
  return hedged(cfg.sttChain.filter((n) => STT[n]?.on()), (n) => STT[n].call(wav));
}
