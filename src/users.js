import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';

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
