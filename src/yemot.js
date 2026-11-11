import { cfg } from './config.js';

const API = 'https://www.call2all.co.il/ym/api/';

// הערך שחוזר מהקלטה הוא נתיב הקובץ בשלוחה. מנרמלים לפורמט ש-DownloadFile מכיר.
function normalize(path) {
  let p = String(path).trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (!/\.(wav|mp3|ogg)$/i.test(p)) p += '.wav';
  return p;
}

export function tokenFor(call) {
  return cfg.yemotToken || call.values?.token || call.values?.ApiYemotToken || '';
}

export async function downloadRecording(path, token) {
  if (cfg.mock) return Buffer.from('RIFF-mock');
  if (!token) throw new Error('חסר טוקן ימות המשיח');
  const url = `${API}DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent('ivr2:' + normalize(path))}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`הורדת הקלטה נכשלה (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// מחיקת ההקלטה אחרי התמלול (פרטיות + ניקיון). אם נכשל, לא קריטי.
export async function deleteRecording(path, token) {
  if (cfg.mock || !token) return;
  try {
    const url = `${API}FileAction?token=${encodeURIComponent(token)}&action=delete&what=${encodeURIComponent('ivr2:' + normalize(path))}`;
    await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch {
    /* לא קריטי */
  }
}
