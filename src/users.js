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
