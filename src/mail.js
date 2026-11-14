import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { cfg } from './config.js';

export const mailEnabled = () => cfg.mock || Boolean(cfg.mailUser && cfg.mailPass);

const own = () => ({ user: cfg.mailUser, pass: cfg.mailPass });
function client(a) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: a.user, pass: a.pass },
    logger: false,
  });
}

// מחזיר עד n הודעות שלא נקראו (החדשות ראשונות)
async function unreadOf(a, n = 5) {
  if (cfg.mock) {
    return [
      { uid: 1, from: 'דוד כהן', fromAddr: 'david@example.com', subject: 'פגישה מחר', text: 'שלום, האם נוכל להיפגש מחר בעשר בבוקר?', messageId: '<1@x>' },
      { uid: 2, from: 'חנות הספרים', fromAddr: 'shop@example.com', subject: 'ההזמנה נשלחה', text: 'הזמנתך יצאה לדרך.', messageId: '<2@x>' },
    ].slice(0, n);
  }
  const c = client(a);
  await c.connect();
  try {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const uids = (await c.search({ seen: false }, { uid: true })) || [];
      const last = uids.slice(-n).reverse();
      const out = [];
      for (const uid of last) {
        const msg = await c.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        out.push({
          uid,
          from: parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || 'שולח לא ידוע',
          fromAddr: parsed.from?.value?.[0]?.address || '',
          subject: parsed.subject || 'בלי נושא',
          text: (parsed.text || '').replace(/\r/g, '').slice(0, 8000),
          messageId: parsed.messageId,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function markReadOf(a, uid) {
  if (cfg.mock) return;
  const c = client(a);
  await c.connect();
  try {
    const lock = await c.getMailboxLock('INBOX');
    try {
      await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function sendReplyOf(a, msg, body) {
  if (cfg.mock) {
    globalThis.__mockSent = [...(globalThis.__mockSent || []), { to: msg.fromAddr, body }];
    return;
  }
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: a.user, pass: a.pass },
  });
  await t.sendMail({
    from: a.user,
    to: msg.fromAddr,
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    text: body,
    inReplyTo: msg.messageId,
    references: msg.messageId,
  });
}

export const unread = (n) => unreadOf(own(), n);
export const markRead = (uid) => markReadOf(own(), uid);
export const sendReply = (msg, body) => sendReplyOf(own(), msg, body);

// ספק מייל לחשבון ג'ימייל של משתמש לפי סיסמת אפליקציה. אותו ממשק כמו שאר הספקים
export function accountProvider(user, pass) {
  const a = { user, pass };
  return { unread: (n) => unreadOf(a, n), markRead: (uid) => markReadOf(a, uid), sendReply: (m, b) => sendReplyOf(a, m, b) };
}

// בודק שהכתובת והסיסמה נכונות (התחברות בלבד)
export async function verifyAccount(user, pass) {
  if (cfg.mock) return pass !== 'badpassword0000';
  const c = client({ user, pass });
  try {
    await c.connect();
    await c.logout();
    return true;
  } catch {
    return false;
  }
}
