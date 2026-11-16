// הדף הראשי של האתר: כניסה אחת לכולם. לפי מי שנכנס, הוא מגיע למקום שלו:
// מנהל הקו -> /admin, צוות הפיקוח -> /staff, כל השאר -> האיזור האישי /my. ומשם גם הרשמה.
import * as users from './users.js';
import { roleOf, ownerPhone, verifyPassword, checkAdminCode, openAdminSession } from './admin.js';
import { openMySession } from './my.js';

const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:16px;color:#222;display:flex;justify-content:center}.card{background:#fff;border-radius:14px;padding:26px;max-width:400px;width:100%;box-shadow:0 2px 12px #0002;margin-top:30px}
input{width:100%;padding:11px;font-size:16px;margin:5px 0;box-sizing:border-box;font-family:inherit}button{width:100%;background:#1a73e8;color:#fff;border:0;border-radius:8px;padding:12px;font-size:17px;cursor:pointer;margin-top:8px}
.err{color:#c62828}.note{color:#666;font-size:13px;line-height:1.5}.links{display:flex;justify-content:space-between;margin-top:16px}a{color:#1a73e8}</style></head><body><div class="card">${body}</div></body></html>`;

let fails = [];
const tooMany = () => {
  fails = fails.filter((t) => Date.now() - t < 10 * 60_000);
  return fails.length > 40;
};

// מזהה (טלפון או שם משתמש) -> מספר טלפון
const phoneOf = (id) => {
  const s = String(id || '').trim();
  const d = s.replace(/[\s-]/g, '');
  return /^\+?\d{9,12}$/.test(d) ? users.normPhone(d) : users.findPhoneByUsername(s);
};

export function addHomeRoutes(app) {
  app.get('/', (req, res) => {
    const e = { 1: 'שם המשתמש או הסיסמה שגויים', many: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' }[req.query.e] || '';
    const ok = req.query.ok ? '<p style="color:#2e7d32">נרשמתם בהצלחה. אפשר להיכנס.</p>' : '';
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).send(page('העוזר החכם בטלפון', `<h1 style="margin-top:0">העוזר החכם בטלפון</h1>${ok}${e ? `<p class="err">${e}</p>` : ''}
<form method="post" action="/login"><input name="id" placeholder="שם משתמש או מספר טלפון" autocomplete="username" required>
<input name="pw" type="password" placeholder="סיסמה" autocomplete="current-password" required><button>כניסה</button></form>
<p class="note">אין עדיין סיסמה? אפשר להיכנס עם מספר הטלפון וקוד שהקו מקריא: מתקשרים לקו, מקישים 4 ואז 7.</p>
<div class="links"><a href="/register">הרשמה</a><a href="/donate">הוספת מפתח Groq</a></div>`));
  });

  app.post('/login', (req, res) => {
    if (tooMany()) return res.redirect('/?e=many');
    const id = String(req.body?.id || '');
    const pw = String(req.body?.pw || '');
    let phone = phoneOf(id);
    let good = !!phone && (users.checkWebPassword(phone, pw) || users.checkWebCode(phone, pw) === 'ok' || checkAdminCode(phone, pw));
    // שם המשתמש והסיסמה הוותיקים של מנהל הקו
    if (!good && verifyPassword(id, pw)) {
      phone = ownerPhone();
      good = true;
      if (!phone) {
        const s = openAdminSession('owner');
        return res.set('set-cookie', s.cookie).redirect(s.to);
      }
    }
    if (!good) {
      fails.push(Date.now());
      return res.redirect('/?e=1');
    }
    const role = roleOf(phone);
    if (role) {
      const s = openAdminSession(role, phone);
      return res.set('set-cookie', s.cookie).redirect(s.to);
    }
    res.set('set-cookie', openMySession(phone)).redirect('/my');
  });

  app.get('/register', (req, res) => {
    const e = { code: 'הקוד שגוי או שפג תוקפו. בקשו קוד חדש בקו (4 ואז 7)', taken: 'שם המשתמש תפוס, בחרו שם אחר', invalid: 'שם משתמש צריך להיות 2 עד 30 תווים, ולא רק ספרות', pw: 'הסיסמאות לא זהות או קצרות מ-6 תווים', phone: 'מספר טלפון לא תקין', many: 'יותר מדי ניסיונות, נסו שוב מאוחר יותר' }[req.query.e] || '';
    res.set('cache-control', 'no-store').send(page('הרשמה', `<h1 style="margin-top:0">הרשמה</h1>${e ? `<p class="err">${e}</p>` : ''}
<p class="note">כדי לוודא שהמספר שלכם, מתקשרים לקו, מקישים 4 (איזור אישי) ואז 7. הקו מקריא קוד בן 6 ספרות.</p>
<form method="post" action="/register"><input name="phone" inputmode="tel" placeholder="מספר הטלפון שממנו מתקשרים לקו" required>
<input name="code" inputmode="numeric" maxlength="6" placeholder="הקוד מהקו" required autocomplete="one-time-code">
<input name="user" placeholder="בחרו שם משתמש" autocomplete="username" required maxlength="30">
<input name="pw" type="password" placeholder="בחרו סיסמה (לפחות 6 תווים)" autocomplete="new-password" required minlength="6">
<input name="pw2" type="password" placeholder="שוב את אותה סיסמה" autocomplete="new-password" required minlength="6"><button>הרשמה</button></form>
<div class="links"><a href="/">כבר רשומים? כניסה</a></div>`));
  });

  app.post('/register', (req, res) => {
    if (tooMany()) return res.redirect('/register?e=many');
    const phone = users.normPhone(req.body?.phone);
    if (phone.length !== 9) return res.redirect('/register?e=phone');
    const pw = String(req.body?.pw || '');
    if (pw.length < 6 || pw !== String(req.body?.pw2 || '')) return res.redirect('/register?e=pw');
    const name = String(req.body?.user || '');
    if (name.trim().length < 2 || name.trim().length > 30 || /^\d+$/.test(name.trim())) return res.redirect('/register?e=invalid');
    const other = users.findPhoneByUsername(name);
    if (other && other !== phone) return res.redirect('/register?e=taken');
    if (users.checkWebCode(phone, req.body?.code) !== 'ok') {
      fails.push(Date.now());
      return res.redirect('/register?e=code');
    }
    const r = users.setUsername(phone, name);
    if (r !== 'ok') return res.redirect(`/register?e=${r}`);
    users.setWebPassword(phone, pw);
    res.redirect('/?ok=1');
  });
}
