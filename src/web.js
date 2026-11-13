import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { cfg } from './config.js';

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1)/i;

// מביא דף אינטרנט ומחזיר {title, text, links:[{text,url}]}
export async function fetchPage(url) {
  if (cfg.mock) {
    return {
      title: 'דף דוגמה',
      text: 'זהו משפט ראשון בדף הדוגמה. זהו משפט שני בדף. ' + 'עוד תוכן ארוך כדי לבדוק קריאה בקטעים. '.repeat(30),
      links: [
        { text: 'קישור ראשון', url: 'https://example.com/a' },
        { text: 'קישור שני', url: 'https://example.com/b' },
      ],
    };
  }
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) throw new Error('כתובת לא מורשית');
  const r = await fetch(u, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; PhoneBrowser/1.0)', 'accept-language': 'he,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`האתר החזיר שגיאה ${r.status}`);
  const html = (await r.text()).slice(0, 3_000_000);
  const dom = new JSDOM(html, { url: r.url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;

  const links = [];
  const allLinks = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 70) continue;
    let href;
    try {
      href = new URL(a.getAttribute('href'), r.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(href.protocol) || seen.has(href.href)) continue;
    seen.add(href.href);
    allLinks.push({ text, url: href.href });
    if (links.length < 8) links.push({ text, url: href.href });
    if (allLinks.length >= 40) break;
  }

  const article = new Readability(doc.cloneNode(true)).parse();
  const text = (article?.textContent || doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return { title: article?.title || doc.title || u.hostname, text: text.slice(0, 20000), links, allLinks };
}
