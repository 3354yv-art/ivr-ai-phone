// הכנת טקסט להקראה בימות המשיח: רק עברית, אנגלית, ספרות ופסיקים.
// התווים . - ' " & | = הם תווים אסורים או מפרידים בפרוטוקול של ימות.

export function clean(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1 נקודה $2')
    .replace(/%/g, ' אחוז ')
    .replace(/&/g, ' ו ')
    .replace(/=/g, ' שווה ')
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/[^֐-׿a-zA-Z0-9, \n]/g, ' ')
    .replace(/[\n\r]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/(, ?){2,}/g, ', ')
    .trim();
}

// מפצל טקסט ארוך לקטעים קצרים לפי סוף משפט (ימות לא אוהבת הקראה ארוכה מדי בבת אחת)
export function chunk(text, max = 350) {
  const sentences = String(text ?? '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let cur = '';
  const push = () => {
    const c = clean(cur);
    if (c) out.push(c);
    cur = '';
  };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      const words = s.split(/\s+/);
      for (const w of words) {
        if ((cur + ' ' + w).length > max) push();
        cur += (cur ? ' ' : '') + w;
      }
      push();
      continue;
    }
    if ((cur + ' ' + s).length > max) push();
    cur += (cur ? ' ' : '') + s;
  }
  push();
  return out;
}
