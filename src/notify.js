import nodemailer from 'nodemailer';
import { cfg } from './config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// מייל התחברות בעברית עם כפתור (ולא קישור גולמי)
export async function sendLoginEmail(to, link) {
  if (cfg.mock) {
    globalThis.__mockEmails = [...(globalThis.__mockEmails || []), { to, link }];
    return;
  }
  if (cfg.brevoKey) return sendBrevo(to, link);
  if (!cfg.smtpUser || !cfg.smtpPass) throw new Error('שליחת מיילים לא הוגדרה');
  const t = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
  const html = loginHtml(link);
  await t.sendMail({
    from: cfg.smtpUser,
    to,
    subject: 'התחברות לקו הטלפון',
    text: `לחיבור המייל לקו הטלפון היכנס לקישור (תקף לחצי שעה): ${link}`,
    html,
  });
}

function loginHtml(link) {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;text-align:right">
<h2 style="margin:0 0 12px">התחברות לקו הטלפון</h2>
<p style="font-size:16px;line-height:1.6">ביקשת לחבר את המייל שלך לקו הטלפון. לחץ על הכפתור כדי להמשיך. הקישור תקף לחצי שעה.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#1a73e8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:18px;display:inline-block">חבר אותי</a></p>
<p style="color:#666;font-size:13px">אם לא ביקשת זאת, אפשר להתעלם מהמייל.</p></div>`;
}

// שליחה דרך Brevo (ברבו): מפתח API בלבד, בלי סיסמת ג׳ימייל
async function sendBrevo(to, link) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: cfg.brevoSender, name: 'העוזר החכם בטלפון' },
      to: [{ email: to }],
      subject: 'התחברות לקו הטלפון',
      htmlContent: loginHtml(link),
      textContent: `לחיבור המייל לקו הטלפון היכנס לקישור (תקף לחצי שעה): ${link}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
