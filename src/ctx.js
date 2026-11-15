// מי המתקשר בשיחה הנוכחית, בלי להעביר אותו בכל פונקציה (לשימוש במפתח האישי של תומכים)
import { AsyncLocalStorage } from 'async_hooks';
const als = new AsyncLocalStorage();
export const withCaller = (phone, fn) => als.run({ phone }, fn);
export const callerPhone = () => als.getStore()?.phone || '';
