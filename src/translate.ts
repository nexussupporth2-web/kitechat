import { api } from './api.ts';

export const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['hi', 'Hindi (हिन्दी)'], ['bn', 'Bengali (বাংলা)'], ['mr', 'Marathi (मराठी)'], ['gu', 'Gujarati (ગુજરાતી)'],
  ['ta', 'Tamil (தமிழ்)'], ['te', 'Telugu (తెలుగు)'], ['kn', 'Kannada (ಕನ್ನಡ)'], ['ml', 'Malayalam (മലയാളം)'], ['pa', 'Punjabi (ਪੰਜਾਬੀ)'],
  ['ur', 'Urdu (اردو)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ru', 'Russian'],
  ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean']
];

const key = (chatId: string) => `kite-translate-${chatId}`;
export const getChatLang = (chatId: string): string => {
  try {
    return localStorage.getItem(key(chatId)) || '';
  } catch {
    return '';
  }
};
export const setChatLang = (chatId: string, lang: string) => {
  try {
    if (lang) localStorage.setItem(key(chatId), lang);
    else localStorage.removeItem(key(chatId));
  } catch {
    /* ignore */
  }
};

const cache = new Map<string, string>();
/** Translates one message. The same message and language are only asked for once. */
export async function translateText(messageId: string, text: string, to: string): Promise<string> {
  const k = `${messageId}|${to}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const r = await api<{ text: string }>('/api/translate', { text, to });
  cache.set(k, r.text);
  return r.text;
}
