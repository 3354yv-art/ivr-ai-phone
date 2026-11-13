// בוחר את המנוע: מקומי (ברירת מחדל) או Gemini (AI_PROVIDER=gemini). במצב בדיקה (MOCK) נשאר המדמה.
import * as gemini from './gemini.js';
import * as local from './local.js';
import * as groq from './groq.js';
import { cfg } from './config.js';

const impl = cfg.mock ? gemini : cfg.aiProvider === 'groq' ? groq : cfg.aiProvider === 'gemini' ? gemini : local;
export const transcribe = (...a) => impl.transcribe(...a);
export const chat = (...a) => impl.chat(...a);
export const search = (...a) => impl.search(...a);
export const findSite = (...a) => impl.findSite(...a);
export const summarize = (...a) => impl.summarize(...a);
