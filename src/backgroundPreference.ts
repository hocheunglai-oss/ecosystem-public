import { useState } from 'react';

export type WaterBackground = 'diffuse' | 'watercolour';
export const BACKGROUND_STORAGE_KEY = 'ecosystem.background.v1';

export function useWaterBackground() {
  const [background, setBackground] = useState<WaterBackground>(() => {
    try { return localStorage.getItem(BACKGROUND_STORAGE_KEY) === 'watercolour' ? 'watercolour' : 'diffuse'; }
    catch { return 'diffuse'; }
  });
  function chooseBackground(value: WaterBackground) {
    setBackground(value);
    try { localStorage.setItem(BACKGROUND_STORAGE_KEY, value); }
    catch { /* Keep the selection usable for this visit when storage is unavailable. */ }
  }
  return { background, chooseBackground };
}
