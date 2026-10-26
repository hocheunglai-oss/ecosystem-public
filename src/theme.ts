import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { prepareHarbourTheme, type HarbourTheme } from "./marine/harbourAssets";
import { transitionMobileHarbour } from "./mobileThemeTransition";

export type Theme = HarbourTheme;
export const THEME_STORAGE_KEY = "ecosystem.theme.v1";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function useTheme({ marine = true, background = 'harbour' }: { marine?: boolean; background?: 'harbour' | 'flowing' } = {}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [requested, setRequested] = useState(theme);
  const [error, setError] = useState("");
  const current = useRef(theme), intent = useRef(theme), request = useRef(0);
  const transition = useRef<{ skipTransition(): void } | null>(null);
  const mounted = useRef(false);
  const marineMode = useRef(marine);
  useLayoutEffect(() => {
    current.current = theme;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The control still works for this visit when browser storage is blocked.
    }
  }, [theme]);
  useLayoutEffect(() => {
    document.documentElement.dataset.themeRequested = requested;
    document.documentElement.dataset.themePending = String(requested !== theme);
  }, [requested, theme]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
      transition.current?.skipTransition();
    };
  }, []);
  useLayoutEffect(() => {
    // A resize can replace the harbour with the mobile business interface.
    // Never let an earlier decode or snapshot commit after that change.
    marineMode.current = marine;
    request.current++;
    transition.current?.skipTransition();
    transition.current = null;
    intent.current = current.current;
    setRequested(current.current);
    setError("");
  }, [marine]);
  useEffect(() => {
    if (!marine || background !== 'harbour') return;
    // Warm both modes during idle use; failed optional loads are retryable on request.
    void prepareHarbourTheme("light").catch(() => {});
    void prepareHarbourTheme("dark").catch(() => {});
  }, [marine, background]);

  async function toggleTheme() {
    const target = intent.current === "light" ? "dark" : "light";
    intent.current = target;
    const ticket = ++request.current;
    transition.current?.skipTransition();
    setRequested(target);
    setError("");
    if (target === current.current) return;
    const commit = () => {
      if (!mounted.current || ticket !== request.current) return;
      flushSync(() => setTheme(target));
    };
    try {
      // The CSS water scene is already present in both themes. Never hold its
      // theme switch hostage to downloading artwork that this interface doesn't use.
      if (background === 'harbour') await prepareHarbourTheme(target);
      if (!mounted.current || ticket !== request.current) return;
      const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches && !document.hidden;
      if (typeof document.startViewTransition === "function" && animate) {
        // Both interfaces commit a complete, decoded scene in the same frame.
        // A transition suppresses rendering during this callback, so never await animation frames here.
        const active = document.startViewTransition(commit);
        transition.current = active;
        // Rapid reversal may intentionally skip the previous snapshot.
        void active.ready.catch(() => {});
        void active.finished.catch(() => {}).finally(() => {
          if (transition.current === active) transition.current = null;
        });
      } else if (background === 'harbour' && !marineMode.current && animate) {
        const active = transitionMobileHarbour(commit);
        transition.current = active;
        void active?.finished.finally(() => {
          if (transition.current === active) transition.current = null;
        });
      } else {
        commit();
      }
    } catch {
      if (mounted.current && ticket === request.current) {
        intent.current = current.current;
        setRequested(current.current);
        setError("Unable to load this mode. Try again.");
      }
    }
  }
  return { theme, requested, toggleTheme, pending: requested !== theme, error };
}
