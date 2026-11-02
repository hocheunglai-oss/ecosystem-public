import { useSyncExternalStore } from 'react';
import { useAccess } from './auth';

export type WaterBackground = 'diffuse' | 'watercolour';
export const BACKGROUND_STORAGE_KEY = 'ecosystem.background.v2';
const defaults = () => 'watercolour' as const;
const listeners = new Set<() => void>();
const temporary = new Map<string, WaterBackground>();
const notify = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(`${BACKGROUND_STORAGE_KEY}:`)) listener();
  };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}

function read(key: string | null): WaterBackground {
  if (!key) return defaults();
  const fallback = temporary.get(key);
  if (fallback) return fallback;
  try { return localStorage.getItem(key) === 'diffuse' ? 'diffuse' : 'watercolour'; }
  catch { return defaults(); }
}

export function useWaterBackground() {
  // A personal display choice belongs to the real account, never VIEW AS.
  // The old shared browser key cannot be safely attributed to any one account.
  const { realUser, preview, previewPerson } = useAccess();
  const key = realUser ? `${BACKGROUND_STORAGE_KEY}:${realUser.id}` : null;
  const background = useSyncExternalStore(subscribe, () => read(key), defaults);
  const canChooseBackground = Boolean(key) && !preview && !previewPerson;
  function chooseBackground(value: WaterBackground) {
    if (!key || !canChooseBackground || (value !== 'diffuse' && value !== 'watercolour')) return;
    try { localStorage.setItem(key, value); temporary.delete(key); }
    catch { temporary.set(key, value); }
    notify();
  }
  return { background, chooseBackground, canChooseBackground };
}
