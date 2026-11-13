// ספקי AI בשרשרת גיבוי: מנסים לפי הסדר, ועוברים לבא כשהמכסה נגמרה או שיש תקלה.
import { cfg } from './config.js';
import { transcribe as sttLocal } from './local.js';

const SYSTEM = [
  'אתה עוזר קולי בטלפון. המשתמש שומע אותך בהקראה ולא קורא.',
  'ענה בעברית, בשפה נקייה ומכובדת, קצר וברור: עד שלושה משפטים אלא אם ביקשו הרחבה.',
  'בלי כוכביות, סימני עיצוב, רשימות, אימוג׳י או קישורים. כתוב משפטים רגילים.',
].join(' ');
export { SYSTEM };

// ---- מודלי שפה ----
const cf = () => `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/ai/v1`;
const LLM = {
  groq: {
    on: () => !!cfg.groqKey,
    call: (m, n) => openai('https://api.groq.com/openai/v1', cfg.groqKey, cfg.groqModel, m, n),
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
    signal: AbortSignal.timeout(12000),
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

const order = () => cfg.chain.filter((n) => LLM[n]?.on());

export async function complete(messages, max_tokens = 220) {
  let last;
  for (const name of order()) {
    try {
      return await LLM[name].call(messages, max_tokens);
    } catch (e) {
      last = e;
      console.warn(`ספק ${name} נכשל: ${e.message}`);
    }
  }
  throw new Error('BUSY', { cause: last });
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
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return String((await r.json()).text || '').trim();
}

const STT = {
  groq: {
    on: () => !!cfg.groqKey,
    call: (w) => sttOpenaiStyle('https://api.groq.com/openai/v1', cfg.groqKey, cfg.groqSttModel, w),
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
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return String((await r.json()).result?.text || '').trim();
    },
  },
  local: { on: () => true, call: (w) => sttLocal(w) },
};

export async function transcribeChain(wav) {
  let last;
  for (const name of cfg.sttChain.filter((n) => STT[n]?.on())) {
    try {
      return await STT[name].call(wav);
    } catch (e) {
      last = e;
      console.warn(`תמלול ${name} נכשל: ${e.message}`);
    }
  }
  throw new Error('BUSY', { cause: last });
}
