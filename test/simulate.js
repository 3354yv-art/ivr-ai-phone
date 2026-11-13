// סימולציה מלאה: שתי שיחות + דפי החיבור. מחקה את ימות המשיח מול השרת עם מוקים לג'מיני, לאתרים ולמייל
import os from 'os';
import fs from 'fs';
import path from 'path';
process.env.MOCK = '1';
process.env.IVR_KEY = 'secret';
process.env.ALLOWED_PHONES = '0501234567';
process.env.MAIL_USER = 'owner@example.com';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'y';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-'));
process.env.ENV_FILE = path.join(process.env.DATA_DIR, 'test.env');
process.env.NO_RESTART = '1';
const { createApp } = await import('../src/server.js');

const server = createApp().listen(0);
const port = server.address().port;
const root = `http://127.0.0.1:${port}`;
const base = `${root}/ivr?key=secret`;
globalThis.__mockDelay = 1200;
let failures = 0;
const check = (name, ok) => { console.log((ok ? 'עבר  ' : 'נכשל ') + name); if (!ok) failures++; };

async function drive(callId, script) {
  globalThis.__mockSpeech = [];
  let si = 0;
  const transcript = [];
  const hit = async (params) => {
    const q = new URLSearchParams({ ApiCallId: callId, ApiPhone: '0501234567', ApiDID: '035551234', ApiExtension: '1', ...params });
    return (await fetch(`${base}&${q}`)).text();
  };
  let resp = await hit({});
  for (let step = 0; step < 500; step++) {
    transcript.push(resp);
    const readSeg = resp.split('&').find((x) => x.startsWith('read='));
    if (!readSeg) break;
    const opts = readSeg.slice(readSeg.lastIndexOf('=') + 1).split(',');
    let value;
    if (opts[2] === 'record') {
      const speech = script[si++];
      globalThis.__mockSpeech.push(speech);
      value = '/ApiRecords/q1';
    } else if (opts[5] !== 'EmailKeyboard' && opts[11] === 'Ok' && opts[12] === 'None') {
      value = 'None'; // המתנה או הקראה - אין הקשה
    } else {
      value = script[si++];
      if (value === undefined) { transcript.push('!! התסריט נגמר'); break; }
    }
    resp = await hit({ [opts[0]]: value });
  }
  return { transcript, used: si, total: script.length };
}
const said = (t, s) => t.some((l) => l.includes(s));
const ended = (t) => t.some((l) => /(go_to_folder=|g-)hangup/.test(l) && !l.includes('read='));

// ---- שיחה א: צ'אט, חיפוש, אתר, ואז מייל כשעדיין לא רשום -> הרשמה ----
const A = await drive('callA', [
  '1', 'מה זה אבטיח', '0',
  '2', '1', 'אבטיח', '1', '1', '3', '1', '0', '0', '0', '0',
  '2', '2', 'example.com', '0', '0', '0',
  '3', 'david@example.com', '1',   // מייל -> הקשת כתובת -> אישור שליחה
  '0',
]);
check('שיחה א: כל ההקשות נצרכו והשיחה נותקה כראוי', A.used === A.total && ended(A.transcript));
check('שיחה א: הופעל מצב המתנה עם מוזיקה', said(A.transcript, 'אנא המתן') && said(A.transcript, 'h-ztomao'));
check('שיחה א: כתובת המייל הוקראה אות אחר אות', said(A.transcript, 'a-david') && said(A.transcript, 'שטרודל'));
check('שיחה א: אין הודעת תקלה', !said(A.transcript, 'תקלה'));

// ---- המייל עם הקישור ----
const em = (globalThis.__mockEmails || [])[0];
check('נשלח מייל עם קישור לכתובת שהוקשה', em?.to === 'david@example.com' && /\/connect\?t=/.test(em?.link || ''));
const link = em.link.replace(/^https?:\/\/[^/]+/, root);
const p1 = await fetch(link);
const h1 = await p1.text();
check('דף החיבור נפתח ומציג כפתור חיבור לג׳ימייל', p1.status === 200 && h1.includes('/auth/google?s='));
const p1b = await fetch(link);
check('הקישור חד-פעמי (שימוש שני נדחה)', p1b.status === 400);
const sid = decodeURIComponent(h1.match(/auth\/google\?s=([^"]+)"/)[1]);
const redir = await fetch(`${root}/auth/google?s=${encodeURIComponent(sid)}`, { redirect: 'manual' });
check('מעבר לגוגל עם state', redir.status === 302 && redir.headers.get('location').includes('accounts.google.com') && redir.headers.get('location').includes('state='));
const cb = await fetch(`${root}/auth/google/callback?code=mock&state=${encodeURIComponent(sid)}`);
check('חזרה מגוגל מסתיימת בהצלחה', cb.status === 200 && (await cb.text()).includes('חובר'));
const bad = await fetch(`${root}/auth/google/callback?code=mock&state=bogus`);
check('state לא מוכר נדחה', bad.status === 400);

// ---- שיחה ב: עכשיו המייל עובד ישירות ----
const B = await drive('callB', ['3', '1', '2', 'תודה רבה', '1', '3', '3', '0']);
check('שיחה ב: המייל עובד ללא הרשמה נוספת', B.used === B.total && ended(B.transcript) && said(B.transcript, 'יש 2 הודעות'));
check('שיחה ב: תשובה נשלחה דרך הג׳ימייל', (globalThis.__mockSent || []).some((x) => x.via === 'gmail' && x.body === 'תודה רבה'));

// ---- אבטחה ----
const t = (u) => fetch(u).then((r) => r.text());
check('מפתח שגוי נחסם', /hangup/.test(await t(`${root}/ivr?key=wrong&ApiCallId=b1&ApiPhone=0501234567&ApiDID=1&ApiExtension=1`)));
check('מספר זר נחסם', /hangup/.test(await t(`${base}&ApiCallId=b2&ApiPhone=0529999999&ApiDID=1&ApiExtension=1`)));
const setupBad = await fetch(`${root}/setup?key=wrong`);
check('דף ההגדרות נעול בלי מפתח נכון', setupBad.status === 403);
const setupOk = await fetch(`${root}/setup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: 'secret', GEMINI_API_KEY: 'k123', YEMOT_TOKEN: '0771111111:pw' }) });
const envTxt = fs.existsSync(process.env.ENV_FILE) ? fs.readFileSync(process.env.ENV_FILE, 'utf8') : '';
check('דף ההגדרות שומר מפתחות בקובץ בהרשאות 600', setupOk.status === 200 && envTxt.includes('GEMINI_API_KEY=k123') && (fs.statSync(process.env.ENV_FILE).mode & 0o777) === 0o600);
const file = path.join(process.env.DATA_DIR, 'users.json');
check('קובץ המשתמשים נשמר בהרשאות 600', (fs.statSync(file).mode & 0o777) === 0o600);

server.close();
console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nכל הבדיקות עברו');
process.exit(failures ? 1 : 0);
