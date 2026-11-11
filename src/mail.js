import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { cfg } from './config.js';

export const mailEnabled = () => cfg.mock || Boolean(cfg.mailUser && cfg.mailPass);

function client() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.mailUser, pass: cfg.mailPass },
    logger: false,
  });
}

// מחזיר עד n הודעות שלא נקראו (החדשות ראשונות)
export async function unread(n = 5) {
  if (cfg.mock) {
    return [
      { uid: 1, from: 'דוד כהן', fromAddr: 'david@example.com', subject: 'פגישה מחר', text: 'שלום, האם נוכל להיפגש מחר בעשר בבוקר?', messageId: '<1@x>' },
      { uid: 2, from: 'חנות הספרים', fromAddr: 'shop@example.com', subject: 'ההזמנה נשלחה', text: 'הזמנתך יצאה לדרך.', messageId: '<2@x>' },
    ].slice(0, n);
  }
  const c = client();
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

export async function markRead(uid) {
  if (cfg.mock) return;
  const c = client();
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

export async function sendReply(msg, body) {
  if (cfg.mock) {
    globalThis.__mockSent = [...(globalThis.__mockSent || []), { to: msg.fromAddr, body }];
    return;
  }
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: cfg.mailUser, pass: cfg.mailPass },
  });
  await t.sendMail({
    from: cfg.mailUser,
    to: msg.fromAddr,
    subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
    text: body,
    inReplyTo: msg.messageId,
    references: msg.messageId,
  });
}
