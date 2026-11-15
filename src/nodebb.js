// חיבור לפורומים מבוססי NodeBB (כמו מתמחים טופ): קריאה, כתיבת פוסטים, צ'אטים והתראות.
// עובד דרך ה-API של הפורום עם החשבון של המתקשר. הסיסמה נשמרת מוצפנת בשרת ולא נשלחת לשום מקום אחר.
import { JSDOM } from 'jsdom';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
export const FORUMS = { 'mitmachim.top': 'מתמחים טופ' };
export const isForumHost = (host) => Object.keys(FORUMS).some((h) => host === h || host.endsWith(`.${h}`));

// HTML של פוסט -> טקסט להקראה
export function htmlText(html) {
  const doc = new JSDOM(`<body>${html || ''}</body>`).window.document;
  doc.querySelectorAll('blockquote').forEach((b) => b.replaceWith(doc.createTextNode(' (ציטוט) ')));
  doc.querySelectorAll('img').forEach((i) => i.replaceWith(doc.createTextNode(i.getAttribute('alt') ? ` ${i.getAttribute('alt')} ` : ' (תמונה) ')));
  doc.querySelectorAll('pre, code').forEach((c) => c.replaceWith(doc.createTextNode(' (קוד) ')));
  doc.querySelectorAll('a').forEach((a) => a.replaceWith(doc.createTextNode(a.textContent || '')));
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

// כמה זמן עבר, בעברית מדוברת
export function ago(t) {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 2) return 'עכשיו';
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : d === 2 ? 'שלשום' : `לפני ${d} ימים`;
}

export class Forum {
  constructor(host) {
    this.base = `https://${host}`;
    this.host = host;
    this.name = FORUMS[host] || host;
    this.cookies = new Map();
    this.csrf = '';
    this.user = null; // { uid, username, userslug }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  keepCookies(r) {
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    for (const c of list) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  async req(path, { method = 'GET', body, form, timeout = 12000 } = {}) {
    const headers = { 'user-agent': UA, accept: 'application/json', cookie: this.cookieHeader() };
    if (method !== 'GET') headers['x-csrf-token'] = this.csrf;
    let payload;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(this.base + path, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    this.keepCookies(r);
    return r;
  }

  async json(path, opts) {
    const r = await this.req(path, opts);
    const t = await r.text();
    if (!r.ok) throw new Error(`${this.host} ${r.status}: ${t.replace(/<[^>]+>/g, ' ').slice(0, 160)}`);
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(`${this.host}: תשובה לא צפויה`);
    }
  }

  async refreshConfig() {
    const c = await this.json('/api/config');
    this.csrf = c.csrf_token || this.csrf;
    if (c.uid) this.user = { uid: c.uid, username: c.username, userslug: c.userslug };
    return c;
  }

  // התחברות עם שם משתמש וסיסמה
  async login(username, password) {
    await this.refreshConfig();
    const r = await this.req('/login', { method: 'POST', form: { username, password, remember: 'on', _csrf: this.csrf } });
    const t = await r.text().catch(() => '');
    if (r.status >= 400) {
      const msg = (() => { try { return JSON.parse(t).message || t; } catch { return t; } })();
      throw new Error(`ההתחברות נכשלה: ${String(msg).replace(/<[^>]+>/g, ' ').slice(0, 120)}`);
    }
    await this.refreshConfig();
    if (!this.user?.uid) throw new Error('ההתחברות נכשלה: שם משתמש או סיסמה שגויים');
    if (!this.user.username) {
      const me = await this.json('/api/me').catch(() => null);
      if (me) this.user = { uid: me.uid, username: me.username, userslug: me.userslug };
    }
    return this.user;
  }

  get loggedIn() {
    return !!this.user?.uid;
  }

  // ---- קריאה ----
  async topics(kind = 'recent') {
    const j = await this.json(`/api/${kind === 'unread' ? 'unread' : kind === 'popular' ? 'popular' : 'recent'}`);
    return (j.topics || []).slice(0, 12).map((t) => ({
      tid: t.tid,
      title: htmlText(t.titleRaw || t.title),
      by: t.user?.displayname || t.user?.username || '',
      posts: t.postcount,
      cat: t.category?.name ? htmlText(t.category.name) : '',
      last: t.lastposttimeISO || t.timestampISO,
      unread: !!t.unread,
    }));
  }

  async topic(tid, page = 1) {
    const j = await this.json(`/api/topic/${tid}?page=${page}`);
    return {
      tid: j.tid,
      title: htmlText(j.titleRaw || j.title),
      cid: j.cid,
      page,
      pages: j.pagination?.pageCount || 1,
      posts: (j.posts || []).map((p) => ({ pid: p.pid, by: p.user?.displayname || p.user?.username || '', at: p.timestampISO, text: htmlText(p.content) })),
    };
  }

  async categories() {
    const j = await this.json('/api/categories');
    const out = [];
    const walk = (list) => {
      for (const c of list || []) {
        if (!c.link) out.push({ cid: c.cid, name: htmlText(c.name) });
        walk(c.children);
      }
    };
    walk(j.categories);
    return out;
  }

  async searchPosts(term) {
    const j = await this.json(`/api/search?term=${encodeURIComponent(term)}&in=titlesposts`);
    return (j.posts || []).slice(0, 8).map((p) => ({ tid: p.topic?.tid || p.tid, title: htmlText(p.topic?.title || ''), by: p.user?.username || '', text: htmlText(p.content).slice(0, 300) }));
  }

  async notifications() {
    const j = await this.json('/api/notifications');
    return (j.notifications || []).slice(0, 10).map((n) => ({ text: htmlText(n.bodyShort), read: !!n.read, at: n.datetimeISO, tid: n.tid, path: n.path }));
  }

  // ---- צ'אטים ----
  async chats() {
    let j;
    try {
      j = await this.json('/api/v3/chats');
      j = j.response || j;
    } catch {
      j = await this.json(`/api/user/${encodeURIComponent(this.user.userslug)}/chats`);
    }
    return (j.rooms || []).slice(0, 12).map((r) => ({
      roomId: r.roomId,
      name: htmlText(r.roomName || r.usernames || (r.users || []).map((u) => u.displayname || u.username).join(' ו') || `חדר ${r.roomId}`),
      unread: !!r.unread,
      last: r.teaser ? htmlText(r.teaser.content) : '',
      lastBy: r.teaser?.user?.username || '',
    }));
  }

  async chatMessages(roomId) {
    let msgs;
    try {
      const j = await this.json(`/api/v3/chats/${roomId}/messages`);
      msgs = (j.response || j).messages;
    } catch {
      const j = await this.json(`/api/user/${encodeURIComponent(this.user.userslug)}/chats/${roomId}`);
      msgs = j.messages;
    }
    return (msgs || []).slice(-15).map((m) => ({ by: m.fromUser?.displayname || m.fromUser?.username || '', mine: m.fromuid === this.user?.uid || m.self === 1, at: m.timestampISO, text: htmlText(m.content || m.cleanedContent) }));
  }

  // ---- כתיבה ----
  async write(path, body) {
    await this.refreshConfig();
    const r = await this.req(path, { method: 'POST', body });
    const t = await r.text();
    if (!r.ok) {
      let msg = t;
      try { msg = JSON.parse(t).status?.message || msg; } catch { /* טקסט */ }
      throw new Error(`השליחה נכשלה: ${String(msg).replace(/<[^>]+>/g, ' ').slice(0, 140)}`);
    }
    try { return JSON.parse(t).response; } catch { return {}; }
  }
  reply(tid, content) {
    return this.write(`/api/v3/topics/${tid}`, { content });
  }
  newTopic(cid, title, content) {
    return this.write('/api/v3/topics', { cid, title, content });
  }
  sendChat(roomId, message) {
    return this.write(`/api/v3/chats/${roomId}`, { message });
  }
}

// חיבורים פתוחים בזיכרון לכל מתקשר, כדי לא להתחבר מחדש בכל פעולה
const live = new Map();
export async function forumFor(phone, host, creds) {
  const key = `${phone}|${host}`;
  const f = live.get(key);
  if (f && (!creds || f.loggedIn) && Date.now() - f.at < 6 * 3600_000) return f;
  const n = new Forum(host);
  if (creds) await n.login(creds.username, creds.password);
  else await n.refreshConfig();
  n.at = Date.now();
  live.set(key, n);
  return n;
}
export const dropForum = (phone, host) => live.delete(`${phone}|${host}`);
