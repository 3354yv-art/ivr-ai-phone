// כל ההגדרות נקראות ממשתני סביבה (קובץ .env בשרת)
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

export const cfg = {
  port: Number(process.env.PORT || 3000),
  // מפתח סודי שנכנס לכתובת השלוחה בימות המשיח (api_link=.../ivr?key=...)
  key: process.env.IVR_KEY || '',
  aiProvider: process.env.AI_PROVIDER || 'chain',
  groqKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  groqSttModel: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
  cerebrasKey: process.env.CEREBRAS_API_KEY || '',
  cerebrasModel: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
  cfAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cfToken: process.env.CLOUDFLARE_API_TOKEN || '',
  cfModel: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  // סדר ניסיון הספקים. מוותרים אוטומטית על ספק בלי מפתח
  hedgeMs: Number(process.env.HEDGE_MS || 1200),
  yemotStt: process.env.YEMOT_STT !== '0',
  chain: (process.env.AI_CHAIN || 'groq,cerebras,cloudflare,local').split(',').map((x) => x.trim()),
  sttChain: (process.env.STT_CHAIN || 'groq,cloudflare,local').split(',').map((x) => x.trim()),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  localModel: process.env.LOCAL_MODEL || 'qwen2.5:3b',
  sttUrl: process.env.STT_URL || 'http://127.0.0.1:8123',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  // טוקן ימות המשיח: מספר מערכת:סיסמה
  yemotToken: process.env.YEMOT_TOKEN || '',
  // רשימת מספרי טלפון מותרים (ריק = כולם). נועד למנוע שימוש זר שעולה כסף
  allowedPhones: list(process.env.ALLOWED_PHONES),
  mailUser: process.env.MAIL_USER || '',
  mailPass: process.env.MAIL_APP_PASSWORD || '',
  music: process.env.MUSIC_NAME || 'ztomao',
  // כתובת ציבורית של השרת (https) - נכנסת לקישור שנשלח במייל ולחיבור גוגל
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || './data',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  // שליחת מיילי הקישור. ברירת מחדל: אותו ג'ימייל של MAIL_USER
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || process.env.MAIL_USER || '',
  smtpPass: process.env.SMTP_PASS || process.env.MAIL_APP_PASSWORD || '',
  mock: process.env.MOCK === '1',
  debug: process.env.DEBUG === '1',
};
