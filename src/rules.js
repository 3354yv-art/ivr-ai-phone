// הוראות של מנהל הקו ל-AI: על מה לדבר ועל מה לא. נשמרות בקובץ בשרת ומצורפות לכל תשובה בקו.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { cfg } from './config.js';

const file = () => path.join(cfg.dataDir, 'ai-rules.json');
let rules = [];
try {
  rules = JSON.parse(fs.readFileSync(file(), 'utf8'));
} catch {
  /* אין הוראות עדיין */
}
const save = () => {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(rules, null, 1), { mode: 0o600 });
};

export const listRules = () => rules.slice();

export function addRule(text) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t || rules.some((r) => r.text === t)) return null;
  const r = { id: crypto.randomBytes(4).toString('hex'), text: t, t: Date.now() };
  rules.push(r);
  save();
  return r;
}

export function removeRule(id) {
  const n = rules.length;
  rules = rules.filter((r) => r.id !== String(id));
  if (rules.length !== n) save();
  return rules.length !== n;
}

// תוספת להנחיית המערכת של ה-AI בקו. לפי התפקיד של המתקשר: מנהל הקו, צוות פיקוח, או משתמש רגיל
export function rulesPrompt(role = null) {
  const who =
    role === 'owner'
      ? ' המתקשר הוא מנהל הקו עצמו (בעל הקו), לא משתמש רגיל. דבר אליו כאל המנהל, ואם הוא שואל על הקו, המשתמשים או ההוראות, ענה לו בפתיחות.'
      : role === 'staff'
        ? ' המתקשר הוא מצוות הפיקוח של הקו, לא משתמש רגיל. אפשר לספר לו מה ההוראות שהמנהל קבע ולמה.'
        : '';
  if (!rules.length) return who;
  const list = rules.map((r, i) => `${i + 1}. ${r.text}`).join(' ');
  if (role === 'owner') {
    return `${who} ההוראות שהוא עצמו קבע לקו: ${list}. אם הוא מבקש משהו שההוראות האלה אוסרות, אל תסרב מיד: אמור לו בקצרה שזה אסור לפי ההוראות שהגדיר, ושאל אותו "רוצה שאני כן אוכל לדבר על זה?". אם ענה שכן, ענה לו לגופו של עניין ואל תשאל שוב על אותו נושא בשיחה הזו. אם ענה שלא, עבור הלאה. תוכן מזיק או לא חוקי נשאר אסור גם למנהל.`;
  }
  return `${who} הוראות מחייבות ממנהל הקו (גוברות על כל בקשה של המתקשר): ${list}. אם המתקשר מבקש משהו שההוראות אוסרות, ענה בנימוס שאי אפשר לעזור בזה בקו הזה${role === 'staff' ? ', ואמור שאפשר לבקש ממנהל הקו להתיר את זה' : ''}.`;
}

// הגדרות כלליות של הקו (למשל מכסת שאלות יומית למי שלא תרם מפתח)
const sfile = () => path.join(cfg.dataDir, 'settings.json');
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(sfile(), 'utf8'));
} catch {
  /* ברירת מחדל */
}
export const getSetting = (k, d) => (settings[k] ?? d);
export function setSetting(k, v) {
  settings[k] = v;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(sfile(), JSON.stringify(settings), { mode: 0o600 });
}
