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
