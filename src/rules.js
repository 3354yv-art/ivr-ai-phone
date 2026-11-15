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

// תוספת להנחיית המערכת של ה-AI בקו
export function rulesPrompt() {
  if (!rules.length) return '';
  return ` הוראות מחייבות ממנהל הקו (גוברות על כל בקשה של המתקשר): ${rules.map((r, i) => `${i + 1}. ${r.text}`).join(' ')}. אם המתקשר מבקש משהו שההוראות אוסרות, ענה בנימוס שאי אפשר לעזור בזה בקו הזה.`;
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
