// חיבור לחשבון גוגל דרך סקריפט שהמשתמש מתקין בחשבון שלו (Google Apps Script).
// הסקריפט רץ אצלו, בשמו, ולכן לא צריך אישור של גוגל. השרת שולח לו בקשות עם מפתח סודי.
import crypto from 'crypto';
import { cfg } from './config.js';

// הקוד שהמשתמש מדביק ב-script.google.com (עם המפתח הסודי שלו בפנים)
export function scriptCode(secret, server = cfg.baseUrl) {
  return `// העוזר החכם בטלפון - חיבור לחשבון גוגל
// הסקריפט רץ רק בחשבון שלך, ועונה רק לבקשות עם המפתח הסודי שלך.
const SECRET = '${secret}';
const SERVER = '${server}';

// כשפותחים את הקישור של הסקריפט, הוא מתחבר לקו לבד
function doGet() {
  let msg;
  try {
    const url = ScriptApp.getService().getUrl();
    const r = UrlFetchApp.fetch(SERVER + '/gs-register', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ secret: SECRET, url: url, email: Session.getActiveUser().getEmail() }), muteHttpExceptions: true });
    msg = r.getResponseCode() === 200 ? 'החשבון חובר לקו בהצלחה. אפשר לסגור את הדף.' : 'החיבור נכשל: ' + r.getContentText();
  } catch (err) { msg = 'החיבור נכשל: ' + err; }
  return HtmlService.createHtmlOutput('<div dir="rtl" style="font-family:Arial;font-size:22px;padding:30px">' + msg + '</div>');
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) {}
  if (req.secret !== SECRET) return out({ error: 'forbidden' });
  try { return out({ ok: true, data: run(req.action, req.args || {}) }); }
  catch (err) { return out({ error: String(err) }); }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function run(action, a) {
  if (action === 'ping') return Session.getActiveUser().getEmail() || 'ok';
  if (action === 'unread') {
    return GmailApp.search('is:unread in:inbox', 0, a.n || 5).map(function (t) {
      const m = t.getMessages().pop();
      return { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), text: m.getPlainBody().slice(0, 6000) };
    });
  }
  if (action === 'markRead') { GmailApp.getMessageById(a.id).markRead(); return true; }
  if (action === 'reply') { GmailApp.getMessageById(a.id).reply(a.body); return true; }
  if (action === 'send') { GmailApp.sendEmail(a.to, a.subject || '', a.body || ''); return true; }
  if (action === 'events') {
    const d = a.date ? new Date(a.date) : new Date();
    return CalendarApp.getDefaultCalendar().getEventsForDay(d).map(function (ev) {
      return { title: ev.getTitle(), start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(), allDay: ev.isAllDayEvent() };
    });
  }
  if (action === 'addEvent') {
    const ev = CalendarApp.getDefaultCalendar().createEvent(a.title, new Date(a.start), new Date(a.end || new Date(new Date(a.start).getTime() + 3600000)));
    return { id: ev.getId() };
  }
  if (action === 'drive') {
    const it = DriveApp.searchFiles('title contains "' + String(a.q || '').replace(/"/g, '') + '" and trashed = false');
    const res = [];
    while (it.hasNext() && res.length < 6) { const f = it.next(); res.push({ name: f.getName(), updated: f.getLastUpdated().toISOString() }); }
    return res;
  }
  if (action === 'readDoc') {
    const it = DriveApp.searchFiles('title contains "' + String(a.q || '').replace(/"/g, '') + '" and mimeType = "application/vnd.google-apps.document" and trashed = false');
    if (!it.hasNext()) return null;
    const f = it.next();
    return { name: f.getName(), text: DocumentApp.openById(f.getId()).getBody().getText().slice(0, 8000) };
  }
  throw new Error('unknown action');
}
`;
}

export const newSecret = () => crypto.randomBytes(18).toString('base64url');

export async function call(url, secret, action, args = {}) {
  if (cfg.mock && globalThis.__gscript) return globalThis.__gscript(action, args);
  if (String(url).startsWith('pull:')) return pullCall(String(url).slice(5), action, args);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, action, args }),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error(/accounts\.google|signin/i.test(t) ? 'הסקריפט לא פתוח לבקשות (צריך לבחור Anyone בפריסה)' : 'תשובה לא צפויה מהסקריפט');
  }
  if (j.error) throw new Error(j.error === 'forbidden' ? 'המפתח הסודי לא תואם' : j.error);
  return j.data;
}

// ספק מייל באותו ממשק כמו שאר הספקים (unread / markRead / sendReply)
export function mailProvider(url, secret) {
  return {
    unread: async (n = 5) =>
      ((await call(url, secret, 'unread', { n })) || []).map((m) => {
        const mm = String(m.from).match(/^(.*?)\s*<([^>]+)>$/);
        return { uid: m.id, from: (mm ? mm[1] : m.from).replace(/"/g, '') || 'שולח לא ידוע', fromAddr: mm ? mm[2] : m.from, subject: m.subject || 'בלי נושא', text: m.text || '' };
      }),
    markRead: (id) => call(url, secret, 'markRead', { id }),
    sendReply: (m, body) => call(url, secret, 'reply', { id: m.uid, body }),
  };
}

// ---------- חיבור פשוט: עותק של קובץ מוכן ----------
// המשתמש יוצר עותק של גיליון גוגל מוכן (הסקריפט כבר בתוכו), ממלא מספר טלפון וקוד חיבור,
// ולוחץ "התחברות" בתפריט. אין פריסה ואין העתקת קוד. הסקריפט פונה לשרת כל דקה (מתזמן),
// ובזמן שיחה הוא נשאר מחובר ומבצע בקשות מיד.
export function templateCode(server = cfg.baseUrl) {
  return `// העוזר החכם בטלפון - חיבור לחשבון גוגל
// הסקריפט רץ רק בחשבון שלכם. הוא שולח לקו את המיילים שלא נקראו ואת היומן, ומבצע את מה שביקשתם בטלפון.
const SERVER = '${server}';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📞 חיבור לקו').addItem('התחברות', 'connect').addItem('ניתוק', 'disconnect').addToUi();
}

function connect() {
  const sh = SpreadsheetApp.getActive().getSheets()[0];
  const phone = String(sh.getRange('B4').getDisplayValue()).replace(/\\D/g, '');
  const code = String(sh.getRange('B5').getDisplayValue()).replace(/\\D/g, '');
  if (phone.length < 9 || code.length < 4) { status('צריך למלא מספר טלפון וקוד חיבור בתאים הצהובים'); return; }
  const r = post('/gs-link', { phone: phone, code: code, email: Session.getActiveUser().getEmail() });
  if (!r.token) { status(r.error || 'החיבור נכשל'); return; }
  PropertiesService.getScriptProperties().setProperty('TOKEN', r.token);
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(1).create();
  sh.getRange('B5').clearContent();
  status('✓ מחובר! אפשר לסגור את הקובץ. העוזר בקו כבר רואה את המיילים והיומן.');
  sync();
}

function disconnect() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().deleteAllProperties();
  status('נותק');
}

function status(t) {
  SpreadsheetApp.getActive().getSheets()[0].getRange('B7').setValue(t);
  try { SpreadsheetApp.getActive().toast(t); } catch (e) {}
}

function post(path, body) {
  const r = UrlFetchApp.fetch(SERVER + path, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  try { return JSON.parse(r.getContentText()); } catch (e) { return { error: 'השרת לא ענה' }; }
}

function snapshot() {
  const unread = GmailApp.search('is:unread in:inbox', 0, 10).map(function (t) {
    const m = t.getMessages().pop();
    return { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), text: m.getPlainBody().slice(0, 3000) };
  });
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 14 * 86400000);
  const events = CalendarApp.getDefaultCalendar().getEvents(from, to).slice(0, 60).map(function (ev) {
    return { title: ev.getTitle(), start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(), allDay: ev.isAllDayEvent() };
  });
  return { unread: unread, events: events, email: Session.getActiveUser().getEmail() };
}

// רץ כל דקה. בזמן שיחה נשאר עד כמעט דקה ומבצע בקשות ברגע שהן מגיעות
function sync() {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;
  try {
    const end = Date.now() + 50000;
    let body = { token: token, snap: snapshot() };
    for (let i = 0; i < 40; i++) {
      const r = post('/gs-poll', body);
      if (r.error === 'unlinked') { disconnect(); return; }
      const results = (r.jobs || []).map(function (j) {
        try { return { id: j.id, ok: true, data: run(j.action, j.args || {}) }; }
        catch (err) { return { id: j.id, error: String(err) }; }
      });
      if (!results.length && !(r.active && Date.now() < end)) break;
      body = { token: token, results: results, wait: Date.now() < end && r.active };
    }
  } finally { lock.releaseLock(); }
}

function run(action, a) {
  if (action === 'ping') return Session.getActiveUser().getEmail() || 'ok';
  if (action === 'unread') return snapshot().unread.slice(0, a.n || 5);
  if (action === 'markRead') { GmailApp.getMessageById(a.id).markRead(); return true; }
  if (action === 'reply') { GmailApp.getMessageById(a.id).reply(a.body); return true; }
  if (action === 'send') { GmailApp.sendEmail(a.to, a.subject || '', a.body || ''); return true; }
  if (action === 'events') {
    const d = a.date ? new Date(a.date) : new Date();
    return CalendarApp.getDefaultCalendar().getEventsForDay(d).map(function (ev) {
      return { title: ev.getTitle(), start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(), allDay: ev.isAllDayEvent() };
    });
  }
  if (action === 'addEvent') {
    const ev = CalendarApp.getDefaultCalendar().createEvent(a.title, new Date(a.start), new Date(a.end || new Date(new Date(a.start).getTime() + 3600000)));
    return { id: ev.getId() };
  }
  if (action === 'drive') {
    const it = DriveApp.searchFiles('title contains "' + String(a.q || '').replace(/"/g, '') + '" and trashed = false');
    const res = [];
    while (it.hasNext() && res.length < 6) { const f = it.next(); res.push({ name: f.getName(), updated: f.getLastUpdated().toISOString() }); }
    return res;
  }
  if (action === 'readDoc') {
    const it = DriveApp.searchFiles('title contains "' + String(a.q || '').replace(/"/g, '') + '" and mimeType = "application/vnd.google-apps.document" and trashed = false');
    if (!it.hasNext()) return null;
    const f = it.next();
    return { name: f.getName(), text: DocumentApp.openById(f.getId()).getBody().getText().slice(0, 8000) };
  }
  throw new Error('unknown action');
}
`;
}

// מצב החיבור הפשוט, בזיכרון: תמונת מצב אחרונה, בקשות שמחכות, ומתי היה הסקריפט בקשר
const pulls = new Map(); // phoneKey -> { snap, seen, jobs:[], waiting:Map, wake:fn, active }
const P = (k) => {
  if (!pulls.has(k)) pulls.set(k, { snap: null, seen: 0, jobs: [], waiting: new Map(), wake: null, active: 0, read: new Set() });
  return pulls.get(k);
};
const WRITES = new Set(['markRead', 'reply', 'send', 'addEvent']);
let jobSeq = 0;

// המתקשר בשיחה עכשיו: הסקריפט יישאר מחובר כדי לענות מהר
export function touch(phoneKey) {
  if (phoneKey) P(phoneKey).active = Date.now();
}
export const lastSeen = (phoneKey) => P(phoneKey).seen;

function enqueue(k, action, args, ms) {
  const s = P(k);
  const id = `${Date.now().toString(36)}${++jobSeq}`;
  s.jobs.push({ id, action, args });
  s.wake?.();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.waiting.delete(id);
      if (WRITES.has(action)) resolve(true); // יתבצע בסנכרון הבא, תוך דקה
      else {
        s.jobs = s.jobs.filter((j) => j.id !== id);
        reject(new Error('גוגל עוד לא ענה. נסו שוב בעוד דקה'));
      }
    }, ms);
    s.waiting.set(id, (r) => {
      clearTimeout(t);
      r.error ? reject(new Error(r.error)) : resolve(r.data);
    });
  });
}

async function pullCall(k, action, args) {
  const s = P(k);
  touch(k);
  if (action === 'ping') return s.snap?.email || 'ok';
  if (action === 'unread' && s.snap) return s.snap.unread.filter((m) => !s.read.has(m.id)).slice(0, args.n || 5);
  if (action === 'events' && s.snap) {
    const day = new Date(args.date || Date.now()).toDateString();
    return s.snap.events.filter((e) => new Date(e.start).toDateString() === day);
  }
  if (action === 'markRead') s.read.add(args.id);
  const live = Date.now() - s.seen < 70000;
  return enqueue(k, action, args, live ? 9000 : 2500);
}

// הסקריפט פונה לכאן: מוסר תמונת מצב ותוצאות, ומקבל בקשות חדשות
export async function poll(k, body) {
  const s = P(k);
  s.seen = Date.now();
  if (body.snap && Array.isArray(body.snap.unread)) {
    s.snap = { unread: body.snap.unread.slice(0, 20), events: (body.snap.events || []).slice(0, 80), email: String(body.snap.email || '') };
    s.read = new Set([...s.read].filter((id) => s.snap.unread.some((m) => m.id === id)));
  }
  for (const r of body.results || []) s.waiting.get(r.id)?.(r), s.waiting.delete(r.id);
  const active = Date.now() - s.active < 4 * 60000;
  if (!s.jobs.length && body.wait && active) {
    await new Promise((res) => {
      const t = setTimeout(res, 15000);
      s.wake = () => (clearTimeout(t), res());
    });
    s.wake = null;
  }
  const jobs = s.jobs.splice(0, 5);
  return { jobs, active: Date.now() - s.active < 4 * 60000 };
}
