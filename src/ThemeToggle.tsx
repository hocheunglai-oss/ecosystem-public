import { Moon, Sun } from 'lucide-react';
import type { Theme } from './theme';

/** One theme control for entry screens and every working-window footer. */
export function ThemeToggle({ theme, onToggle, pending = false, error, className = '' }: {
  theme: Theme;
  onToggle: () => void;
  pending?: boolean;
  error?: string;
  className?: string;
}) {
  return <button
    type="button"
    role="switch"
    aria-label="Dark mode"
    aria-checked={theme === 'dark'}
    aria-busy={pending}
    title={error?.toUpperCase() || undefined}
    className={`theme-mode-toggle ${className}`}
    data-mode={theme}
    onClick={onToggle}
  >
    <span className="theme-mode-toggle__thumb" aria-hidden="true" />
    <Sun className="theme-mode-toggle__sun" aria-hidden="true" />
    <Moon className="theme-mode-toggle__moon" aria-hidden="true" />
  </button>;
}
