// דיבור בקול של גוגל קלאוד (ברור יותר מהקול הרגיל של ימות).
// הטקסט הופך לקובץ שמע, עולה לתיקייה במערכת של ימות, ומושמע משם. קבצים נשמרים במטמון לפי התוכן.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cfg } from './config.js';

// קולות גבריים בעברית
export const VOICES = [
  { id: 'yemot', name: 'הקול הרגיל של המערכת' },
  { id: 'he-IL-Wavenet-D', name: 'קול גברי ברור' },
  { id: 'he-IL-Wavenet-B', name: 'קול גברי עמוק' },
  { id: 'he-IL-Chirp3-HD-Charon', name: 'קול גברי טבעי במיוחד' },
  { id: 'he-IL-Chirp3-HD-Puck', name: 'קול גברי צעיר' },
  { id: 'he-IL-Standard-D', name: 'קול גברי פשוט' },
];
export const DEFAULT_VOICE = 'he-IL-Wavenet-D';
export const RATES = { slow: 0.85, normal: 1.0, fast: 1.2 };
export const googleVoiceOn = () => !!cfg.googleCloudKey && !cfg.mock;

// ---------- מונה שימוש חודשי: מגן מפני חיוב. מעבר למכסה -> חוזרים לקול הרגיל של ימות ----------
// המכסה החינמית של גוגל: WaveNet ו-Standard 4 מיליון תווים בחודש, Chirp3 HD מיליון. כאן נעצרים הרבה לפניה.
// קול מסוג אחר (Studio, Neural2 וכו') חסום לגמרי כי הוא יקר.
const LIMITS = {
  wavenet: Number(process.env.TTS_LIMIT_WAVENET || 3_000_000),
  standard: Number(process.env.TTS_LIMIT_STANDARD || 3_000_000),
  chirp: Number(process.env.TTS_LIMIT_CHIRP || 800_000),
};
export const tierOf = (v) => (/Chirp3-HD/i.test(v) ? 'chirp' : /Wavenet/i.test(v) ? 'wavenet' : /Standard/i.test(v) ? 'standard' : 'blocked');
const usageFile = () => path.join(cfg.dataDir, 'tts-usage.json');
const monthKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    if (u.month === monthKey()) return u;
  } catch { /* חדש */ }
  return { month: monthKey(), wavenet: 0, standard: 0, chirp: 0 };
}
// מוסיף למונה ומחזיר false אם זה חורג מהמכסה (ואז לא שולחים לגוגל)
export function chargeTts(voice, chars) {
  const tier = tierOf(voice);
  if (tier === 'blocked') return false;
  const u = readUsage();
  if (u[tier] + chars > LIMITS[tier]) return false;
  u[tier] += chars;
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(u), { mode: 0o600 });
  } catch { /* לא קריטי */ }
  return true;
}
export const ttsUsage = () => readUsage();

const cache = new Map(); // hash -> path בימות
const pending = new Map();

async function synth(text, voice, rate) {
  if (!chargeTts(voice, text.length)) throw new Error('quota-guard: monthly TTS limit reached');
  const body = {
    input: { text },
    voice: { languageCode: 'he-IL', name: voice },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000, speakingRate: rate },
  };
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(cfg.googleCloudKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`google tts ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return Buffer.from((await r.json()).audioContent, 'base64');
}

async function upload(token, name, wav) {
  const fd = new FormData();
  fd.append('token', token);
  fd.append('path', `ivr2:/ai_tts/${name}.wav`);
  fd.append('convertAudio', '0');
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), `${name}.wav`);
  const r = await fetch('https://www.call2all.co.il/ym/api/UploadFile', { method: 'POST', body: fd, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.responseStatus !== 'OK') throw new Error(`upload ${r.status} ${j.message || ''}`);
}

// מחזיר נתיב קובץ להשמעה בימות, או null אם אין קול של גוגל / נכשל (ואז מקריאים בקול הרגיל)
export async function voiceFile(text, voice, rate, token) {
  if (!googleVoiceOn() || !token || !voice || voice === 'yemot' || !text) return null;
  let v = voice;
  const name = crypto.createHash('sha1').update(`${v}|${rate}|${text}`).digest('hex').slice(0, 20);
  if (cache.has(name)) return cache.get(name);
  if (!pending.has(name)) {
    pending.set(name, (async () => {
      let wav;
      try {
        wav = await synth(text, v, rate);
      } catch (e) {
        // קול שלא קיים בעברית: חוזרים לקול ברירת המחדל
        if (v !== DEFAULT_VOICE && !/quota-guard/.test(e.message) && /400|404|not exist|not available/i.test(e.message)) wav = await synth(text, DEFAULT_VOICE, rate);
        else throw e;
      }
      await upload(token, name, wav);
      const p = `/ai_tts/${name}`;
      cache.set(name, p);
      if (cache.size > 3000) cache.delete(cache.keys().next().value);
      return p;
    })().finally(() => pending.delete(name)));
  }
  try {
    return await pending.get(name);
  } catch (e) {
    console.warn('קול גוגל נכשל:', e.message);
    return null;
  }
}
