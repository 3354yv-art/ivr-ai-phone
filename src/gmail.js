import { cfg } from './config.js';

const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send';
export const googleEnabled = () => Boolean(cfg.googleClientId && cfg.googleClientSecret);
const redirectUri = () => `${cfg.baseUrl}/auth/google/callback`;

export function authUrl(state) {
  const q = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// מחליף קוד אישור בטוקן רענון ומחזיר גם את כתובת המייל שאושרה
export async function exchangeCode(code) {
  if (cfg.mock) return { refresh: 'mock-refresh', email: 'david@example.com' };
  const tok = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: cfg.googleClientId,
    client_secret: cfg.googleClientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  if (!tok.refresh_token) throw new Error('גוגל לא החזיר טוקן רענון');
  const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.json());
  if (!info.email) throw new Error('לא התקבלה כתובת מייל מגוגל');
  return { refresh: tok.refresh_token, email: info.email };
}

const b64u = (s) => Buffer.from(s).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

function bodyOf(payload) {
  const find = (p, type) => {
    if (p.mimeType === type && p.body?.data) return fromB64u(p.body.data);
    for (const c of p.parts || []) {
      const r = find(c, type);
      if (r) return r;
    }
    return '';
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain;
  return find(payload, 'text/html').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// ספק מייל של ג'ימייל עבור משתמש לפי טוקן הרענון שלו. אותו ממשק כמו mail.js
export function provider(refresh) {
  if (cfg.mock) {
    return {
      async unread(n = 5) {
        return [
          { uid: 'g1', from: 'דוד כהן', fromAddr: 'david2@example.com', subject: 'פגישה מחר', text: 'שלום, האם נוכל להיפגש מחר בעשר בבוקר?', messageId: '<1@x>' },
          { uid: 'g2', from: 'חנות הספרים', fromAddr: 'shop@example.com', subject: 'ההזמנה נשלחה', text: 'הזמנתך יצאה לדרך.', messageId: '<2@x>' },
        ].slice(0, n);
      },
      async markRead() {},
      async sendReply(msg, body) {
        globalThis.__mockSent = [...(globalThis.__mockSent || []), { to: msg.fromAddr, body, via: 'gmail' }];
      },
    };
  }
  let access = null;
  let exp = 0;
  const token = async () => {
    if (access && Date.now() < exp) return access;
    const t = await postForm('https://oauth2.googleapis.com/token', {
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    access = t.access_token;
    exp = Date.now() + (t.expires_in - 60) * 1000;
    return access;
  };
  const api = async (path, opts = {}) => {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const header = (m, name) => m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value || '';
  return {
    async unread(n = 5) {
      const list = await api(`messages?q=${encodeURIComponent('is:unread in:inbox')}&maxResults=${n}`);
      const out = [];
      for (const { id } of list.messages || []) {
        const m = await api(`messages/${id}?format=full`);
        const from = header(m, 'from');
        const addr = (from.match(/<([^>]+)>/) || [, from])[1].trim();
        const name = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || addr;
        out.push({
          uid: id,
          threadId: m.threadId,
          from: name,
          fromAddr: addr,
          subject: header(m, 'subject') || 'בלי נושא',
          text: bodyOf(m.payload).slice(0, 8000),
          messageId: header(m, 'message-id'),
        });
      }
      return out;
    },
    async markRead(id) {
      await api(`messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
    },
    async sendReply(msg, body) {
      const subj = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
      const raw = [
        `To: ${msg.fromAddr}`,
        `Subject: =?UTF-8?B?${Buffer.from(subj).toString('base64')}?=`,
        msg.messageId ? `In-Reply-To: ${msg.messageId}` : '',
        msg.messageId ? `References: ${msg.messageId}` : '',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(body).toString('base64'),
      ].filter((l, i) => l !== '' || i > 4).join('\r\n');
      await api('messages/send', { method: 'POST', body: JSON.stringify({ raw: b64u(raw), threadId: msg.threadId }) });
    },
  };
}
