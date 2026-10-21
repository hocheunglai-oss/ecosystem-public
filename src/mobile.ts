import { useLayoutEffect, useSyncExternalStore } from "react";

export const MOBILE_INTERFACE_QUERY =
  "(max-width: 760px), (max-width: 1100px) and (pointer: coarse), (max-height: 600px) and (pointer: coarse)";

let media: MediaQueryList | undefined;

function mobileMedia() {
  if (typeof window === "undefined") return undefined;
  return (media ??= window.matchMedia(MOBILE_INTERFACE_QUERY));
}

function subscribe(onChange: () => void) {
  const query = mobileMedia();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/** Keep phones, open foldables and touch tablets on the business interface. */
export function useMobileInterface() {
  const mobile = useSyncExternalStore(
    subscribe,
    () => mobileMedia()?.matches ?? false,
    () => false,
  );
  useLayoutEffect(() => {
    document.documentElement.dataset.interface = mobile ? "mobile" : "desktop";
  }, [mobile]);
  return mobile;
}
