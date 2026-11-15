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
// מוק של פורום NodeBB (מתמחים טופ)
globalThis.__forum = { posted: [], chats: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  const url = String(u);
  if (url === 'https://api.groq.com/openai/v1/models') return new Response('{}', { status: String(o.headers?.authorization).includes('gsk_good') ? 200 : 401 });
  if (!url.startsWith('https://mitmachim.top')) return realFetch(u, o);
  const p = url.slice('https://mitmachim.top'.length);
  const ck = String(o.headers?.cookie || '');
  const logged = ck.includes('express.sid=ok');
  const J = (b, s = 200, h = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...h } });
  if (p.startsWith('/api/config')) return J({ csrf_token: 'tok', uid: logged ? 7 : 0, username: logged ? 'יודע ומייבין' : undefined, userslug: 'yodea' });
  if (p === '/login') return new URLSearchParams(o.body).get('password') === 'goodpass' ? J({}, 200, { 'set-cookie': 'express.sid=ok; Path=/' }) : J({ message: 'invalid-login-credentials' }, 403);
  if (p.startsWith('/api/unread') || p.startsWith('/api/recent')) return J({ topics: [{ tid: 5, title: 'איך מתקינים אנקר', user: { username: 'משה' }, postcount: 2, lastposttimeISO: new Date().toISOString() }] });
  if (p.startsWith('/api/topic/5')) return J({ tid: 5, title: 'איך מתקינים אנקר', posts: [{ pid: 1, user: { username: 'משה' }, timestampISO: new Date().toISOString(), content: '<p>מישהו יודע איך מתקינים?</p>' }, { pid: 2, user: { username: 'דוד' }, timestampISO: new Date().toISOString(), content: '<p>מורידים מהקישור</p>' }] });
  if (p === '/api/v3/topics/5' && o.method === 'POST') { if (!logged || o.headers['x-csrf-token'] !== 'tok') return J({}, 403); globalThis.__forum.posted.push(JSON.parse(o.body).content); return J({ response: { pid: 3 } }); }
  if (p === '/api/v3/chats') return J({ response: { rooms: [{ roomId: 1, roomName: 'שמעון', unread: true, teaser: { content: 'שלום' } }] } });
  return J({}, 404);
};
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
  '2', '1', 'אבטיח', '1', '1', 'תסכם לי', 'תחזור אחורה', '0',
  '2', 'example.com', 'תחזור', '0', '0',
  '3', '2', 'david@example.com', '1',   // מייל -> הקשת כתובת -> אישור שליחה
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

// ---- חיבור בהקשה: כתובת + סיסמת אפליקציה ----
const C = await drive('callC', ['4', '2', '1', 'dina@gmail.com', 'abcdefghijklmnop', '0', '0']);
const acc = (await import('../src/users.js')).getAppAccount('0501234567');
check('חיבור בהקשה: כתובת וסיסמת אפליקציה נשמרו (מוצפן)', C.used === C.total && acc?.user === 'dina@gmail.com' && acc?.pass === 'abcdefghijklmnop' && !fs.readFileSync(path.join(process.env.DATA_DIR || '.', 'users.json'), 'utf8').includes('abcdefghijklmnop'));

// ---- התאמה אישית ----
const D = await drive('callD', ['4', '3', 'קוראים לי משה', '0', '1', 'תזכור שאני גר בירושלים', 'מה זה', '0', '0']);
const prefs = (await import('../src/users.js')).getPrefs('0501234567');
check('התאמה אישית: נשמר מהאיזור האישי ומ"תזכור" בשיחה', ended(D.transcript) && prefs.includes('קוראים לי משה') && prefs.includes('אני גר בירושלים'));

// ---- פורום: חיבור חשבון מאתר הניהול, קריאה ותגובה בקו ----
{
  const crypto = await import('crypto');
  const salt = crypto.randomBytes(16);
  process.env.ADMIN_HASH = `${salt.toString('hex')}:${crypto.scryptSync('pass12345', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
  const lg = await fetch(`${root}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ u: 'יהונתן', p: 'pass12345' }) });
  const cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  const post = (o) => fetch(`${root}/admin/site-account`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(o) });
  const bad = await post({ p: '0501234567', host: 'mitmachim.top', u: 'yodea', pw: 'wrong' });
  check('פורום: סיסמה שגויה נדחית ולא נשמרת', decodeURIComponent(bad.headers.get('location') || '').includes('נכשל') && !(await import('../src/users.js')).getSiteAccount('0501234567', 'mitmachim.top'));
  const ok = await post({ p: '0501234567', host: 'mitmachim.top', u: 'yodea', pw: 'goodpass' });
  check('פורום: חיבור החשבון מאתר הניהול', decodeURIComponent(ok.headers.get('location') || '').includes('מחובר') && !fs.readFileSync(path.join(process.env.DATA_DIR, 'users.json'), 'utf8').includes('goodpass'));
  const F = await drive('callF', ['2', '3', 'תפתח 1', 'תגיב שתודה רבה על העזרה', '1', 'צ׳אטים', '', '', '0', '0', '0']);
  check('פורום: נכנס בחשבון, הקריא נושא ופרסם תגובה אחרי אישור', said(F.transcript, 'בחשבון יודע ומייבין') && said(F.transcript, 'מישהו יודע איך מתקינים') && globalThis.__forum.posted.includes('תודה רבה על העזרה'));
  check('פורום: רשימת צ׳אטים מוקראת', said(F.transcript, 'שמעון') && F.used === F.total && ended(F.transcript));
}

// ---- תומכי הקו: תרומת מפתח עם מספר, הטבות ומכסה ----
{
  const { setSetting } = await import('../src/rules.js');
  setSetting('dailyLimit', 1);
  const G = await drive('callG', ['1', 'שאלה ראשונה', '1', 'שאלה שנייה', '0']);
  check('מכסה: מי שאינו תומך נעצר אחרי המכסה ושומע איך להצטרף', said(G.transcript, 'הגעת למכסה'));
  const don = await fetch(`${root}/donate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ k: 'gsk_good1234567890123456789012', phone: '050-1234567', ok: '1' }) });
  check('תרומה: מפתח עם מספר טלפון נקלט ומראה את ההטבות', don.status === 200 && (await don.text()).includes('הטבות התומכים'));
  const H = await drive('callH', ['1', 'שאלה ראשונה', '1', 'שאלה שנייה', '0', '0']);
  check('תומך: ברכה אישית ובלי מכסה', said(H.transcript, 'לתומך הקו') && !said(H.transcript, 'הגעת למכסה') && H.used === H.total);
  setSetting('dailyLimit', 0);
}

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

// ---- אתר הניהול: תיקים, הוראות ושיחה עם ה-AI ----
{
  const crypto = await import('crypto');
  const salt = crypto.randomBytes(16);
  process.env.ADMIN_HASH = `${salt.toString('hex')}:${crypto.scryptSync('pass12345', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
  const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(o) });
  let cookie = '';
  const login = await fetch(`${root}/admin/login`, form({ u: 'יהונתן', p: 'pass12345' }));
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('ניהול: כניסה עם הסיסמה', login.status === 302 && cookie.startsWith('adm='));
  const get = (u) => fetch(`${root}${u}`, { headers: { cookie } }).then((r) => r.text());
  const home = await get('/admin');
  check('ניהול: מספר מלא עם 0 ומופיע פעם אחת בלבד', home.includes('0501234567') && home.split('<b>0501234567</b>').length === 2);
  const folder = await get('/admin/p/501234567');
  check('ניהול: התיק מציג מה נאמר ומה ה-AI ענה, עם שעה', folder.includes('msg me') && folder.includes('msg bot') && folder.includes('מה זה אבטיח') && folder.includes('שיחה התחילה'));
  await fetch(`${root}/admin/rules/add`, form({ text: 'אל תדבר על ספורט' }));
  check('ניהול: הוראה נשמרה ונכנסת להנחיה של ה-AI', (await get('/admin/rules')).includes('אל תדבר על ספורט') && (await import('../src/rules.js')).rulesPrompt().includes('אל תדבר על ספורט'));
  await fetch(`${root}/admin/chat`, form({ text: 'הוראה: ענה תמיד בקצרה' }));
  const ch = await get('/admin/chat');
  check('ניהול: שיחה עם ה-AI עונה ומוסיפה הוראה', ch.includes('הבנתי') && ch.includes('נוספה הוראה') && (await get('/admin/rules')).includes('ענה תמיד בקצרה'));
  const noAuth = await fetch(`${root}/admin/p/501234567`);
  check('ניהול: תיק לא נפתח בלי כניסה', !(await noAuth.text()).includes('msg bot'));
  const blk = await fetch(`${root}/admin/block`, form({ p: '0501234567', back: '1' }));
  check('ניהול: חסימה מתוך התיק חוזרת לתיק', blk.status === 302 && /\/admin\/p\/501234567/.test(blk.headers.get('location') || ''));
}

server.close();
console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nכל הבדיקות עברו');
process.exit(failures ? 1 : 0);
