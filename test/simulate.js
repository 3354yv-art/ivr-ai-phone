// סימולציה מלאה: שתי שיחות + דפי החיבור. מחקה את ימות המשיח מול השרת עם מוקים לג'מיני, לאתרים ולמייל
import os from 'os';
import fs from 'fs';
import path from 'path';
process.env.MOCK = '1';
process.env.IVR_KEY = 'secret';
process.env.ALLOWED_PHONES = '0501234567,0507654321';
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

async function drive(callId, script, phone = '0501234567') {
  globalThis.__mockSpeech = [];
  let si = 0;
  const transcript = [];
  const hit = async (params) => {
    const q = new URLSearchParams({ ApiCallId: callId, ApiPhone: phone, ApiDID: '035551234', ApiExtension: '1', ...params });
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
  '1', 'מה זה אבטיח', 'די',
  '2', '1', 'אבטיח', 'תיכנס לראשון', 'תסכם לי', 'תחזור אחורה', 'די',
  '2', 'example.com', 'תחזור', '0', '0',
  '3', '2', 'david@example.com', '1',   // מייל -> הקשת כתובת -> אישור שליחה
  '0',
]);
check('שיחה א: כל ההקשות נצרכו והשיחה נותקה כראוי', A.used === A.total && ended(A.transcript));
check('שיחה א: הופעל מצב המתנה עם מוזיקה', /רגע|שנייה|בודק/.test(A.transcript.join(' ')) && said(A.transcript, 'h-ztomao'));
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
const C = await drive('callC', ['4', '2', '3', '1', 'dina@gmail.com', 'abcdefghijklmnop', '0', '0']);
const acc = (await import('../src/users.js')).getAppAccount('0501234567');
check('חיבור בהקשה: כתובת וסיסמת אפליקציה נשמרו (מוצפן)', C.used === C.total && acc?.user === 'dina@gmail.com' && acc?.pass === 'abcdefghijklmnop' && !fs.readFileSync(path.join(process.env.DATA_DIR || '.', 'users.json'), 'utf8').includes('abcdefghijklmnop'));

// ---- התאמה אישית ----
const D = await drive('callD', ['4', '3', 'קוראים לי משה', '0', '1', 'תזכור שאני גר בירושלים', 'מה זה', 'די', '0']);
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
  const G = await drive('callG', ['1', 'שאלה ראשונה', 'שאלה שנייה', '0']);
  check('מכסה: מי שאינו תומך נעצר אחרי המכסה ושומע איך להצטרף', said(G.transcript, 'הגעת למכסה'));
  const don = await fetch(`${root}/donate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ k: 'gsk_good1234567890123456789012', phone: '050-1234567', ok: '1' }) });
  check('תרומה: מפתח עם מספר טלפון נקלט', don.status === 200 && (await don.text()).includes('על שם המספר'));
  const H = await drive('callH', ['1', 'שאלה ראשונה', 'שאלה שנייה', 'די', '0']);
  check('תומך: ברכה אישית ובלי מכסה', said(H.transcript, 'מתומכי הקו') && !said(H.transcript, 'הגעת למכסה') && H.used === H.total);
  setSetting('dailyLimit', 0);
}

// ---- איזור אישי באתר: קוד מהקו, כניסה, הוספת זיכרון ----
{
  const W = await drive('callW', ['4', '7', '0', '0']);
  const m = W.transcript.join(' ').match(/הקוד שלך הוא[:,]? ((?:\d, ){5}\d)/);
  const code = m ? m[1].replace(/\D/g, '') : '';
  check('אתר אישי: הקו מקריא קוד בן 6 ספרות', code.length === 6);
  const bad = await fetch(`${root}/my/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: '0501234567', code: '000000' }) });
  check('אתר אישי: קוד שגוי נדחה', (bad.headers.get('location') || '').includes('e=wrong'));
  const ok = await fetch(`${root}/my/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: '050-1234567', code }) });
  const ck = (ok.headers.get('set-cookie') || '').split(';')[0];
  await fetch(`${root}/my/pref`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck }, body: new URLSearchParams({ t: 'אוהב תשובות קצרות' }) });
  const pg = await (await fetch(`${root}/my`, { headers: { cookie: ck } })).text();
  check('אתר אישי: כניסה, היסטוריה וזיכרון שנוסף', ck.startsWith('my=') && pg.includes('אוהב תשובות קצרות') && pg.includes('השיחות שלי') && pg.includes('0501234567'));
  const post = (u, o) => fetch(`${root}${u}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck }, body: new URLSearchParams(o) });
  await post('/my/shortcut', { name: 'דוגמה', url: 'example.com' });
  await post('/my/settings', { length: 'short' });
  const us = (await import('../src/users.js'));
  check('אתר אישי: קיצור והגדרת אורך נשמרו', us.getShortcuts('0501234567')[0]?.url === 'https://example.com' && us.getSettings('0501234567').length === 'short');
  const S = await drive('callS', ['2', '4', '1', 'תחזור', '0', '0']);
  check('קו: נכנסים לאתר דרך קיצור', said(S.transcript, 'נפתח הדף') && S.used === S.total && ended(S.transcript));
  const again = await fetch(`${root}/my/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: '0501234567', code }) });
  check('אתר אישי: קוד חד-פעמי', (again.headers.get('location') || '').includes('e='));
}

// ---- ניהול בקו: מנהל הקו וצוות פיקוח ----
{
  const rules = await import('../src/rules.js');
  const adm = await import('../src/admin.js');
  rules.setSetting('owner', '0501234567');
  const M = await drive('callM', ['9', '1', '0507654321', '3', 'הטרדה', '7', '1', '0507777777', '0', '0']);
  const bi = adm.blockInfo('0507654321');
  check('ניהול בקו: המנהל חסם מספר לשבוע עם סיבה', bi?.reason === 'הטרדה' && bi.until > Date.now() + 6 * 86400_000 && M.used === M.total);
  check('ניהול בקו: המנהל הוסיף איש צוות', adm.roleOf('0507777777') === 'staff');
  const St = await drive('callSt', ['9', '6', '5', '0', '0'], '0507777777');
  check('צוות: יש תפריט ניהול, בלי הוראות AI (6 לא קיים)', said(St.transcript, 'תפריט ניהול לצוות הפיקוח') && !said(St.transcript, 'להוראות ל-AI'));
  const code = (St.transcript.join(' ').match(/לאתר הניהול הוא[:,]? ((?:\d, ){5}\d)/) || [])[1]?.replace(/\D/g, '');
  const lc = await fetch(`${root}/staff/login-code`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: '0507777777', code: code || '' }) });
  const sc = (lc.headers.get('set-cookie') || '').split(';')[0];
  const home = await (await fetch(`${root}/staff`, { headers: { cookie: sc } })).text();
  const rulesRes = await fetch(`${root}/staff/rules`, { headers: { cookie: sc } });
  check('צוות: נכנס לאתר הצוות עם קוד, רואה תיקים אבל לא הוראות', sc.startsWith('stf=') && home.includes('צוות הפיקוח') && rulesRes.status === 403);
  const Nb = await drive('callNb', ['0'], '0507654321');
  check('חסום שומע סיבה', said(Nb.transcript, 'הטרדה'));
  adm.unblockPhone('0507654321');
  rules.setSetting('owner', '');
}

// ---- סיסמה קבועה ואתר צוות נפרד ----
{
  const us = await import('../src/users.js');
  const ad = await import('../src/admin.js');
  ad.addStaff('0521111111', 'דוד');
  us.setWebPassword('0521111111', 'staffpass1');
  const F = (u, o, ck = '') => fetch(`${root}${u}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck }, body: new URLSearchParams(o) });
  const sl = await F('/staff/login-code', { phone: '0521111111', code: 'staffpass1' });
  const sck = (sl.headers.get('set-cookie') || '').split(';')[0];
  check('צוות: כניסה לאתר הצוות עם סיסמה קבועה', sck.startsWith('stf=') && (sl.headers.get('location') || '') === '/staff');
  const sp = await (await fetch(`${root}/staff`, { headers: { cookie: sck } })).text();
  check('צוות: האתר הנפרד מציג תיקים עם קישורים ל-/staff', sp.includes('אתר צוות הפיקוח') && sp.includes('href="/staff/p/') && !sp.includes('href="/admin'));
  const sr = await fetch(`${root}/staff/rules`, { headers: { cookie: sck } });
  check('צוות: אין גישה להוראות ל-AI', sr.status === 403);
  const al = await F('/admin/login-code', { phone: '0521111111', code: 'staffpass1' });
  check('צוות: אי אפשר להיכנס לאתר המנהל', (al.headers.get('location') || '').includes('e=1'));
  const ml = await F('/my/login', { phone: '0521111111', code: 'staffpass1' });
  check('סיסמה קבועה: נכנסים גם לאיזור האישי', (ml.headers.get('set-cookie') || '').startsWith('my='));
}

// ---- אתר אחד לכולם: הרשמה וכניסה שמפנה כל אחד למקום שלו ----
{
  const us = await import('../src/users.js');
  const ad = await import('../src/admin.js');
  const P = (u, o) => fetch(`${root}${u}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  const home = await (await fetch(`${root}/`)).text();
  check('דף ראשי: טופס כניסה אחד עם הרשמה ומפתח', home.includes('action="/login"') && home.includes('/register') && home.includes('/donate'));
  const code = us.createWebCode('0533333333');
  const reg = await P('/register', { phone: '0533333333', code, user: 'משה כהן', pw: 'moshe123', pw2: 'moshe123' });
  check('הרשמה: עם קוד מהקו, שם משתמש וסיסמה', (reg.headers.get('location') || '').includes('ok=1') && us.findPhoneByUsername('משה כהן') === '533333333');
  const taken = await P('/register', { phone: '0544444444', code: us.createWebCode('0544444444'), user: 'משה כהן', pw: 'abcdef1', pw2: 'abcdef1' });
  check('הרשמה: שם תפוס נדחה', (taken.headers.get('location') || '').includes('e=taken'));
  const lu = await P('/login', { id: 'משה כהן', pw: 'moshe123' });
  check('כניסה: משתמש רגיל מגיע לאיזור האישי', lu.headers.get('location') === '/my' && (lu.headers.get('set-cookie') || '').startsWith('my='));
  ad.addStaff('0533333333', 'משה');
  const ls = await P('/login', { id: '0533333333', pw: 'moshe123' });
  check('כניסה: צוות פיקוח מגיע לאתר הצוות', ls.headers.get('location') === '/staff' && (ls.headers.get('set-cookie') || '').startsWith('stf='));
  ad.removeStaff('0533333333');
  const lo = await P('/login', { id: 'יהונתן', pw: 'pass12345' });
  check('כניסה: מנהל הקו מגיע לאתר המנהלים', lo.headers.get('location') === '/admin' && (lo.headers.get('set-cookie') || '').startsWith('adm='));
  const bad = await P('/login', { id: 'משה כהן', pw: 'nope' });
  check('כניסה: סיסמה שגויה נדחית', (bad.headers.get('location') || '').includes('e=1'));
  const dn = await (await fetch(`${root}/donate`)).text();
  check('דף מפתח: רק מפתח ומספר טלפון', dn.includes('name="k"') && dn.includes('name="phone"') && !dn.includes('הטבות'));
}

// ---- שיחה רציפה ופורום בטלפון ----
{
  const R = await drive('callR', ['1', 'מה זה אבטיח', 'מה זה מלון', 'די', '0']);
  check('שיחה רציפה: שתי שאלות ברצף בלי תפריט באמצע', R.used === R.total && !said(R.transcript, 'לשאלה נוספת') && said(R.transcript, 'חוזרים לתפריט'));
  const us = await import('../src/users.js');
  us.removeSiteAccount('0501234567', 'mitmachim.top');
  const FC = await drive('callFC', ['4', '2', '2', '1', 'yodea@example.com', 'goodpass', '0', '0']);
  check('פורום: חיבור החשבון דרך הטלפון', said(FC.transcript, 'החשבון חובר בהצלחה') && us.getSiteAccount('0501234567', 'mitmachim.top')?.username === 'yodea@example.com');
}

// ---- חיבור גוגל דרך סקריפט ----
{
  const us = await import('../src/users.js');
  const gs = await import('../src/gscript.js');
  const secret = us.gsSecret('0501234567', gs.newSecret);
  globalThis.__gscript = (action, args) => ({ ping: 'me@gmail.com', unread: [{ id: 'm1', from: 'רבקה <r@x.com>', subject: 'שלום', text: 'מה שלומך' }], events: [{ title: 'שיעור', start: '2026-11-20T18:00:00+02:00', end: '2026-11-20T19:00:00+02:00', allDay: false }] }[action]);
  check('סקריפט גוגל: קוד עם מפתח אישי', gs.scriptCode(secret).includes(secret) && secret.length > 15);
  us.setGScript('0501234567', 'https://script.google.com/macros/s/abc/exec', 'me@gmail.com');
  const prov = gs.mailProvider('u', secret);
  const un = await prov.unread(5);
  check('סקריפט גוגל: מייל דרך הסקריפט', un[0].from === 'רבקה' && un[0].fromAddr === 'r@x.com');
  // פקודות קוליות על שירותי גוגל דרך הפעולה הכללית api
  globalThis.__gscript = (action, args) => {
    if (action !== 'api') return undefined;
    const u = String(args.url);
    if (u.includes('/tasks/v1/')) return { status: 200, data: args.method === 'post' ? {} : { items: [{ title: 'לקנות חלב' }] } };
    if (u.includes('/drive/v3/files')) return { status: 200, data: { files: [{ name: 'מצגת חגים' }] } };
    if (u.includes('people.googleapis.com')) return { status: 200, data: { results: [{ person: { names: [{ displayName: 'דוד כהן' }], phoneNumbers: [{ value: '050-123-4567' }] } }] } };
    if (u.includes('/youtube/v3/playlists')) return { status: 200, data: { items: [{ snippet: { title: 'שיעורים' } }] } };
    return { status: 404, data: {} };
  };
  const GV = await drive('callGv', ['1', 'מה ברשימת המשימות שלי', 'תוסיף משימה לקנות חלב', 'אילו מצגות יש לי', 'מה המספר של דוד', 'אילו רשימות השמעה יש לי', 'די', '0']);
  check('גוגל בקול: משימות, מצגות, אנשי קשר ויוטיוב', said(GV.transcript, 'לקנות חלב') && said(GV.transcript, 'הוספתי את המשימה') && said(GV.transcript, 'מצגת חגים') && said(GV.transcript, 'דוד כהן') && said(GV.transcript, 'שיעורים'));
  us.removeGScript('0501234567');
  check('סקריפט גוגל: ניתוק', !us.getGScript('0501234567'));
  const s2 = us.gsSecret('0501234567', gs.newSecret);
  const bad = await fetch(`${root}/gs-register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'wrong', url: 'https://script.google.com/macros/s/x/exec' }) });
  const good = await fetch(`${root}/gs-register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: s2, url: 'https://script.google.com/macros/s/abc_1/exec', email: 'me@gmail.com' }) });
  check('סקריפט גוגל: נרשם לבד כשפותחים את הקישור, ומפתח שגוי נדחה', bad.status === 403 && good.status === 200 && us.getGScript('0501234567')?.url.endsWith('abc_1/exec'));
  us.removeGScript('0501234567');
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
  const blk = await fetch(`${root}/admin/block`, form({ p: '0501234567', back: '1', reason: 'חיפושים לא ראויים', d: 'week' }));
  check('ניהול: חסימה מתוך התיק חוזרת לתיק', blk.status === 302 && /\/admin\/p\/501234567/.test(blk.headers.get('location') || ''));
  const Bk = await drive('callBk', []);
  check('חסימה: המתקשר שומע את הסיבה ולכמה זמן', said(Bk.transcript, 'נחסם לעוד 7 ימים') && said(Bk.transcript, 'חיפושים לא ראויים'));
  await fetch(`${root}/admin/unblock`, form({ p: '0501234567' }));
  const Ub = await drive('callUb', ['0']);
  check('חסימה: אחרי שחרור אפשר להתקשר', !said(Ub.transcript, 'נחסם'));
}

{
  // חיבור פשוט: עותק קובץ + טלפון + קוד, והסקריפט מסנכרן מול השרת
  const users = await import('../src/users.js');
  const gsm = await import('../src/gscript.js');
  const saved = globalThis.__gscript;
  globalThis.__gscript = null;
  const post = (u, b) => fetch(`${root}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const code = users.gsLinkCode('0527777777');
  const bad = await post('/gs-link', { phone: '0527777777', code: '000000', email: 'a@gmail.com' });
  const ok = await post('/gs-link', { phone: '0527777777', code, email: 'a@gmail.com' });
  check('גוגל פשוט: קוד שגוי נדחה, קוד נכון מחבר', !bad.token && !!ok.token && !!users.getGScript('0527777777'));
  await post('/gs-poll', { token: ok.token, snap: { unread: [{ id: 'x1', from: 'דוד <d@x.com>', subject: 'שלום', text: 'טקסט' }], events: [], email: 'a@gmail.com' } });
  const g = users.getGScript('0527777777');
  const un = await gsm.mailProvider(g.url, g.secret).unread(5);
  check('גוגל פשוט: המיילים מגיעים מהסנכרון', un.length === 1 && un[0].from === 'דוד');
  gsm.touch('527777777');
  const pr = gsm.call(g.url, g.secret, 'drive', { q: 'חשבון' });
  const p1 = await post('/gs-poll', { token: ok.token, wait: true });
  const job = p1.jobs[0];
  await post('/gs-poll', { token: ok.token, results: [{ id: job.id, ok: true, data: [{ name: 'חשבון חשמל' }] }] });
  const res = await pr;
  check('גוגל פשוט: בקשה בזמן שיחה מבוצעת ומחזירה תשובה', job.action === 'drive' && res[0].name === 'חשבון חשמל');
  const un2 = await post('/gs-poll', { token: 'wrong' });
  check('גוגל פשוט: מפתח לא מוכר מקבל ניתוק', un2.error === 'unlinked');
  check('גוגל פשוט: קוד הסקריפט תקין', (() => { try { new Function(gsm.templateCode('http://x')); return true; } catch { return false; } })());
  globalThis.__gscript = saved;
}

// תפקידים: ה-AI מותאם למנהל ולצוות הפיקוח
{
  const rl = await import('../src/rules.js');
  const r1 = rl.addRule('אל תדבר על ספורט');
  const own = rl.rulesPrompt('owner');
  const stf = rl.rulesPrompt('staff');
  const usr = rl.rulesPrompt(null);
  check('תפקידים: מנהל מקבל הצעה לדבר בכל זאת', own.includes('מנהל הקו עצמו') && own.includes('רוצה שאני כן אוכל לדבר על זה'));
  check('תפקידים: צוות פיקוח מוכר אבל בלי לעקוף הוראות', stf.includes('צוות הפיקוח') && !stf.includes('רוצה שאני כן אוכל'));
  check('תפקידים: משתמש רגיל מקבל סירוב רגיל', usr.includes('אי אפשר לעזור') && !usr.includes('מנהל הקו עצמו'));
  if (r1) rl.removeRule(r1.id);
}

// היסטוריה: שאלות ותשובות מזווגות
{
  const ad = await import('../src/admin.js');
  ad.logQuery('0526000111', 'שיחה עם AI', 'מה מזג האוויר');
  ad.logAnswer('0526000111', 'שיחה עם AI', 'שמשי');
  ad.logQuery('0526000111', 'שיחה עם AI', 'מה השעה');
  const qa = ad.qaFor('0526000111', 5);
  check('היסטוריה: זוגות שאלה ותשובה, חדש ראשון', qa.length === 2 && qa[1].q === 'מה מזג האוויר' && qa[1].a === 'שמשי' && qa[0].q === 'מה השעה' && qa[0].a === '');
}

// הגנת חיוב: מונה חודשי לקול גוגל
{
  const v = await import('../src/voice.js');
  check('מונה קול: סוגי קולות', v.tierOf('he-IL-Wavenet-D') === 'wavenet' && v.tierOf('he-IL-Chirp3-HD-Puck') === 'chirp' && v.tierOf('he-IL-Standard-D') === 'standard' && v.tierOf('he-IL-Studio-B') === 'blocked');
  check('מונה קול: קול יקר נחסם', v.chargeTts('he-IL-Studio-B', 10) === false);
  const before = v.ttsUsage().wavenet;
  check('מונה קול: קול רגיל נספר', v.chargeTts('he-IL-Wavenet-D', 100) === true && v.ttsUsage().wavenet === before + 100);
  check('מונה קול: חריגה מהמכסה נעצרת', v.chargeTts('he-IL-Wavenet-D', 5_000_000) === false);
}

server.close();
console.log(failures ? `\n${failures} בדיקות נכשלו` : '\nכל הבדיקות עברו');
process.exit(failures ? 1 : 0);
