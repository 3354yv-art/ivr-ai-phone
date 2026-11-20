// דפדפן אמיתי בשרת (כרומיום דרך Playwright): העוזר יכול ללחוץ על כפתורים, למלא שדות ולשלוח טפסים.
// לכל שיחה יש לשונית משלה. אם Playwright לא מותקן, הקו ממשיך לעבוד בקריאת דפים רגילה.
let pw = null;
let browserP = null;
const sessions = new Map(); // id -> { ctx, page, at }

export async function available() {
  if (pw === false) return false;
  if (pw) return true;
  try {
    pw = await import('playwright');
    return true;
  } catch {
    pw = false;
    return false;
  }
}

async function browser() {
  if (!browserP) {
    browserP = pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    browserP.catch(() => (browserP = null));
  }
  return browserP;
}

async function tab(id) {
  let s = sessions.get(id);
  if (s && !s.page.isClosed()) {
    s.at = Date.now();
    return s.page;
  }
  const b = await browser();
  const ctx = await b.newContext({ locale: 'he-IL', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  s = { ctx, page, at: Date.now() };
  sessions.set(id, s);
  return page;
}

export async function close(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  if (s) await s.ctx.close().catch(() => {});
}

// סוגרים לשוניות שלא היו בשימוש 10 דקות
setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.at > 10 * 60_000) close(id);
}, 60_000).unref();

// צילום מצב של הדף: כותרת, טקסט, ורשימת רכיבים שאפשר ללחוץ עליהם או למלא
async function snapshot(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(600);
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    document.querySelectorAll('[data-ivr]').forEach((e) => e.removeAttribute('data-ivr'));
    const els = [];
    const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [onclick]';
    for (const el of document.querySelectorAll(sel)) {
      if (els.length >= 120 || !vis(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isField = (tag === 'input' && !['submit', 'button', 'checkbox', 'radio', 'image'].includes(type)) || tag === 'textarea' || tag === 'select';
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!label && !isField) continue;
      const i = els.length + 1;
      el.setAttribute('data-ivr', String(i));
      els.push({ i, kind: isField ? (tag === 'select' ? 'בחירה' : 'שדה') : tag === 'a' ? 'קישור' : 'כפתור', text: label || (isField ? 'שדה טקסט' : ''), href: tag === 'a' ? el.href : '' });
    }
    const main = document.querySelector('main, article, [role=main]') || document.body;
    return { title: document.title, text: (main.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 12000), els };
  });
  return { ...data, url: page.url(), links: data.els.filter((e) => e.kind === 'קישור').map((e) => ({ text: e.text, url: e.href })), allLinks: data.els.map((e) => ({ text: `${e.kind}: ${e.text}`, url: e.href, i: e.i })) };
}

export async function open(id, url) {
  const page = await tab(id);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return snapshot(page);
}

// פעולה בדף: click / fill / back. מחזיר מצב חדש של הדף
export async function act(id, a) {
  const page = await tab(id);
  if (a.type === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return snapshot(page);
  }
  const el = page.locator(`[data-ivr="${Number(a.index)}"]`).first();
  if (a.type === 'click') {
    const nav = page.waitForNavigation({ timeout: 8000 }).catch(() => {});
    await el.click({ timeout: 8000 });
    await Promise.race([nav, page.waitForTimeout(2500)]);
  } else if (a.type === 'fill') {
    const tag = await el.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') await el.selectOption({ label: a.text }).catch(() => el.selectOption(a.text));
    else await el.fill(String(a.text || ''));
    if (a.submit) {
      const nav = page.waitForNavigation({ timeout: 8000 }).catch(() => {});
      await el.press('Enter');
      await Promise.race([nav, page.waitForTimeout(3000)]);
    }
  }
  return snapshot(page);
}
