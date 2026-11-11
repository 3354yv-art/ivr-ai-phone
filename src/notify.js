import nodemailer from 'nodemailer';
import { cfg } from './config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// מייל התחברות בעברית עם כפתור (ולא קישור גולמי)
export async function sendLoginEmail(to, link) {
  if (cfg.mock) {
    globalThis.__mockEmails = [...(globalThis.__mockEmails || []), { to, link }];
    return;
  }
  if (!cfg.smtpUser || !cfg.smtpPass) throw new Error('שליחת מיילים לא הוגדרה');
  const t = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;text-align:right">
<h2 style="margin:0 0 12px">התחברות לקו הטלפון</h2>
<p style="font-size:16px;line-height:1.6">ביקשת לחבר את המייל שלך לקו הטלפון. לחץ על הכפתור כדי להמשיך. הקישור תקף לחצי שעה.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#1a73e8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:18px;display:inline-block">חבר אותי</a></p>
<p style="color:#666;font-size:13px">אם לא ביקשת זאת, אפשר להתעלם מהמייל.</p></div>`;
  await t.sendMail({
    from: cfg.smtpUser,
    to,
    subject: 'התחברות לקו הטלפון',
    text: `לחיבור המייל לקו הטלפון היכנס לקישור (תקף לחצי שעה): ${link}`,
    html,
  });
}
