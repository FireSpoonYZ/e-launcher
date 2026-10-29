import { createContext, useContext, useState } from 'react';
import { CircleAlert } from 'lucide-react';

export type UiLanguage = 'system' | 'zh' | 'en';
export const LanguageOverride = createContext<UiLanguage | undefined>(undefined);

export function useText() {
  const language = useContext(LanguageOverride);
  const en = language === 'en' || ((language === 'system' || language === undefined) && navigator.language.startsWith('en'));
  return (zh: string, english: string) => en ? english : zh;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const array = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export function useAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setError(''); setBusy(true);
    try { return await operation(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return {error, setError, busy, run};
}

export function ErrorNotice({error}: {error?: string}) {
  return error ? <div className="inline-error" role="alert"><CircleAlert/><span>{error}</span></div> : null;
}
