import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';
import { isDonor } from './pool.js';

// משתמשים נשמרים בקובץ JSON (הרשאות 600). המפתח הוא 9 הספרות האחרונות של הטלפון.
const file = () => path.join(cfg.dataDir, 'users.json');
let db = {};
try {
  db = JSON.parse(fs.readFileSync(file(), 'utf8'));
} catch {
  /* קובץ חדש */
}
const save = () => {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(db, null, 1), { mode: 0o600 });
};

export const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-9);
export const getUser = (phone) => db[normPhone(phone)] || null;

export function setEmailVerified(phone, email) {
  const k = normPhone(phone);
  db[k] = { ...(db[k] || {}), email: email.toLowerCase(), verifiedAt: Date.now() };
  save();
}
// סיסמת אפליקציה נשמרת מוצפנת (AES-256-GCM) במפתח מהשרת
const dkey = () => crypto.createHash('sha256').update(`ivr-ai:${process.env.DATA_KEY || cfg.key || 'local'}`).digest();
const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dkey(), iv);
  const d = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map((b) => b.toString('base64')).join('.');
};
const dec = (t) => {
  const [iv, tag, d] = t.split('.').map((x) => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', dkey(), iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString('utf8');
};
export function setAppPassword(phone, email, pass) {
  const k = normPhone(phone);
  db[k] = { ...(db[k] || {}), email: email.toLowerCase(), app: enc(pass), verifiedAt: Date.now() };
  save();
}
export function getAppAccount(phone) {
  const u = getUser(phone);
  if (!u?.app || !u.email) return null;
  try {
    return { user: u.email, pass: dec(u.app) };
  } catch {
    return null;
  }
}

// חיבור לחשבון גוגל דרך סקריפט בחשבון של המשתמש: כתובת הסקריפט והמפתח הסודי (מוצפנים)
export function gsSecret(phone, make) {
  const k = normPhone(phone);
  if (!k) return '';
  const cur = db[k]?.gs?.secret ? dec(db[k].gs.secret) : '';
  if (cur || !make) return cur;
  const s = make();
  db[k] = { ...(db[k] || {}), gs: { ...(db[k]?.gs || {}), secret: enc(s) } };
  save();
  return s;
}
export function phoneByGsSecret(secret) {
  for (const k of Object.keys(db)) {
    try {
      if (db[k]?.gs?.secret && dec(db[k].gs.secret) === secret) return k;
    } catch { /* פגום */ }
  }
  return '';
}
export function setGScript(phone, url, email) {
  const k = normPhone(phone);
  if (!k || !db[k]?.gs?.secret) return false;
  db[k].gs = { ...db[k].gs, url: enc(url), email: String(email || ''), t: Date.now() };
  save();
  return true;
}
export function getGScript(phone) {
  const g = getUser(phone)?.gs;
  if (!g?.url || !g?.secret) return null;
  try {
    return { url: dec(g.url), secret: dec(g.secret), email: g.email || '' };
  } catch {
    return null;
  }
}
// קוד חיבור קצר (6 ספרות) לחיבור דרך עותק של הקובץ המוכן
// קודי חיבור קבועים שהמנהל קבע: GS_FIXED_CODES=טלפון:קוד,טלפון:קוד
const fixedCode = (k) => {
  for (const part of String(process.env.GS_FIXED_CODES || '').split(',')) {
    const [p, c] = part.split(':').map((x) => (x || '').trim());
    if (p && c && normPhone(p) === k) return c.replace(/\D/g, '');
  }
  return '';
};
export function gsLinkCode(phone) {
  const k = normPhone(phone);
  if (!k) return '';
  if (fixedCode(k)) return fixedCode(k);
  if (!db[k]?.gsCode) {
    db[k] = { ...(db[k] || {}), gsCode: String(crypto.randomInt(100000, 1000000)) };
    save();
  }
  return db[k].gsCode;
}
const linkFails = new Map();
export function linkGsPull(phone, code, token, email) {
  const k = normPhone(phone);
  const f = linkFails.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 3600000) (f.n = 0), (f.t = Date.now());
  const want = k ? fixedCode(k) || db[k]?.gsCode : '';
  if (!k || f.n >= 6 || !want || want !== String(code)) {
    f.n++;
    linkFails.set(k, f);
    return false;
  }
  db[k] = { ...(db[k] || {}), gs: { secret: enc(token), url: enc(`pull:${k}`), email: String(email || ''), t: Date.now() } };
  delete db[k].gsCode;
  save();
  return k;
}
export function removeGScript(phone) {
  const k = normPhone(phone);
  if (db[k]?.gs) { delete db[k].gs; save(); }
}

// חשבונות באתרים (כמו פורום מתמחים טופ). הסיסמה נשמרת מוצפנת
export function setSiteAccount(phone, host, username, password) {
  const k = normPhone(phone);
  if (!k) return false;
  const sites = { ...(db[k]?.sites || {}), [host]: { u: String(username), p: enc(String(password)), t: Date.now() } };
  db[k] = { ...(db[k] || {}), sites };
  save();
  return true;
}
export function getSiteAccount(phone, host) {
  const s = getUser(phone)?.sites?.[host];
  if (!s) return null;
  try {
    return { username: s.u, password: dec(s.p) };
  } catch {
    return null;
  }
}
export function removeSiteAccount(phone, host) {
  const k = normPhone(phone);
  if (db[k]?.sites?.[host]) {
    delete db[k].sites[host];
    save();
  }
}
export const siteAccounts = (phone) => Object.entries(getUser(phone)?.sites || {}).map(([host, s]) => ({ host, username: s.u }));

// התאמה אישית: דברים שהמתקשר ביקש שהעוזר יזכור (עד 15)
export const getPrefs = (phone) => getUser(phone)?.prefs || [];
export function addPref(phone, text) {
  const k = normPhone(phone);
  const t = String(text || '').trim().slice(0, 300);
  if (!k || !t) return false;
  const prefs = [...(db[k]?.prefs || []), t].slice(isDonor(k) ? -50 : -15);
  db[k] = { ...(db[k] || {}), prefs };
  save();
  return true;
}
export function clearPrefs(phone) {
  const k = normPhone(phone);
  if (db[k]) { delete db[k].prefs; save(); }
}
export function removePref(phone, i) {
  const k = normPhone(phone);
  if (db[k]?.prefs?.[i] === undefined) return;
  db[k].prefs.splice(i, 1);
  save();
}
export function disconnectMail(phone) {
  const k = normPhone(phone);
  if (!db[k]) return;
  delete db[k].app;
  delete db[k].google;
  save();
}

// סיסמה קבועה לאתר (במקום קוד בכל פעם). נשמרת כגיבוב scrypt, לא כטקסט
export function setWebPassword(phone, pw) {
  const k = normPhone(phone);
  if (!k || String(pw).length < 6) return false;
  const salt = crypto.randomBytes(16);
  db[k] = { ...(db[k] || {}), webPass: `${salt.toString('hex')}:${crypto.scryptSync(String(pw), salt, 64).toString('hex')}` };
  save();
  return true;
}
export function checkWebPassword(phone, pw) {
  const h = getUser(phone)?.webPass;
  if (!h || !pw) return false;
  const [s, x] = h.split(':');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(x, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export const hasWebPassword = (phone) => !!getUser(phone)?.webPass;
export function clearWebPassword(phone) {
  const k = normPhone(phone);
  if (db[k]?.webPass) { delete db[k].webPass; save(); }
}

// שם משתמש לאתר (ייחודי). מאפשר להיכנס עם שם במקום מספר טלפון
const unorm = (n) => String(n || '').normalize('NFC').trim().toLowerCase();
export function findPhoneByUsername(name) {
  const n = unorm(name);
  if (!n) return '';
  return Object.keys(db).find((k) => db[k]?.username && unorm(db[k].username) === n) || '';
}
export function setUsername(phone, name) {
  const k = normPhone(phone);
  const n = String(name || '').normalize('NFC').trim();
  if (!k || n.length < 2 || n.length > 30 || /^\d+$/.test(n)) return 'invalid';
  const other = findPhoneByUsername(n);
  if (other && other !== k) return 'taken';
  db[k] = { ...(db[k] || {}), username: n };
  save();
  return 'ok';
}
export const usernameOf = (phone) => getUser(phone)?.username || '';

// קוד כניסה לאיזור האישי באתר: הקו מקריא אותו למתקשר, וכך מוכח שהמספר שלו
const webCodes = new Map(); // phone -> { code, until, tries }
export function createWebCode(phone) {
  const code = String(crypto.randomInt(100000, 1000000));
  webCodes.set(normPhone(phone), { code, until: Date.now() + 15 * 60_000, tries: 0 });
  return code;
}
export function checkWebCode(phone, code) {
  const k = normPhone(phone);
  const c = webCodes.get(k);
  if (!c || Date.now() > c.until) return 'expired';
  if (++c.tries > 5) {
    webCodes.delete(k);
    return 'expired';
  }
  if (c.code !== String(code).replace(/\D/g, '')) return 'wrong';
  webCodes.delete(k);
  return 'ok';
}

// הגדרות אישיות: קול, אורך תשובות, מהירות דיבור, וקיצורי אתרים
export const getSettings = (phone) => getUser(phone)?.settings || {};
export function setSetting(phone, key, value) {
  const k = normPhone(phone);
  if (!k) return;
  db[k] = { ...(db[k] || {}), settings: { ...(db[k]?.settings || {}), [key]: value } };
  save();
}
export const getShortcuts = (phone) => getUser(phone)?.shortcuts || [];
export function addShortcut(phone, name, url) {
  const k = normPhone(phone);
  if (!k || !name || !url) return false;
  const list = (db[k]?.shortcuts || []).filter((s) => s.name !== name);
  list.push({ name: String(name).slice(0, 60), url: String(url).slice(0, 300) });
  db[k] = { ...(db[k] || {}), shortcuts: list.slice(-20) };
  save();
  return true;
}
export function removeShortcut(phone, i) {
  const k = normPhone(phone);
  if (db[k]?.shortcuts?.[i] === undefined) return;
  db[k].shortcuts.splice(i, 1);
  save();
}

// שם המתקשר, אם סיפר לעוזר ("קוראים לי משה", "השם שלי משה")
export function nameOf(phone) {
  for (const p of getPrefs(phone)) {
    const m = String(p).match(/(?:קוראים לי|השם שלי|שמי)\s+([\u0590-\u05FFa-zA-Z]{2,15})/);
    if (m) return m[1];
  }
  return '';
}
// השיחה האחרונה עם העוזר, כדי להמשיך ממנה בשיחה הבאה (נשמרת 3 ימים)
export function saveLastChat(phone, history) {
  const k = normPhone(phone);
  if (!k) return;
  db[k] = { ...(db[k] || {}), lastChat: { t: Date.now(), h: history.slice(-12).map((m) => ({ role: m.role, text: String(m.text).slice(0, 600) })) } };
  save();
}
export function getLastChat(phone) {
  const c = getUser(phone)?.lastChat;
  return c && Date.now() - c.t < 72 * 3600_000 ? c.h : null;
}

export const personaOf = (phone) => getPrefs(phone).join('. ');

export function setGoogle(phone, google) {
  const k = normPhone(phone);
  db[k] = { ...(db[k] || {}), email: google.email.toLowerCase(), google: { refresh: google.refresh }, verifiedAt: Date.now() };
  save();
}

// קישורי התחברות: חד-פעמיים, תוקף חצי שעה. מוגבל ל-3 מיילים בשעה לכל טלפון.
const tokens = new Map();
const sessions = new Map();
const sent = new Map();
const TTL = 30 * 60 * 1000;
const rnd = () => crypto.randomBytes(24).toString('base64url');

export function createLoginToken(phone, email) {
  const k = normPhone(phone);
  const recent = (sent.get(k) || []).filter((t) => Date.now() - t < 3600_000);
  if (recent.length >= 3) throw Object.assign(new Error('rate'), { code: 'rate' });
  sent.set(k, [...recent, Date.now()]);
  const t = rnd();
  tokens.set(t, { phone: k, email, exp: Date.now() + TTL });
  return t;
}
export function consumeLoginToken(t) {
  const r = tokens.get(t);
  tokens.delete(t);
  return r && r.exp > Date.now() ? r : null;
}
export function createSession(phone) {
  const s = rnd();
  sessions.set(s, { phone: normPhone(phone), exp: Date.now() + TTL });
  return s;
}
export function getSession(s) {
  const r = sessions.get(s);
  return r && r.exp > Date.now() ? r : null;
}
export const dropSession = (s) => sessions.delete(s);
