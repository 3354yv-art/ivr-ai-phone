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
