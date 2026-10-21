import type { KeyboardEvent } from "react";

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  '[contenteditable]:not([contenteditable="false"])',
  "audio[controls]",
  "video[controls]",
].join(",");

/** Keep keyboard traversal inside the active dialog, including its final control. */
export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (
    event.key !== "Tab" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.defaultPrevented
  )
    return;
  const dialog = event.currentTarget;
  const target = event.target instanceof Element ? event.target : null;

  // A nested dialog handles its own key event; its parent must never move focus.
  if (!dialog.open || target?.closest("dialog") !== dialog) return;
  const candidates = Array.from(
    dialog.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => {
    if (
      element.closest("dialog") !== dialog ||
      element.closest("[hidden], [inert]")
    )
      return false;
    if (
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true"
    )
      return false;
    if (element.tabIndex < 0 || element.getClientRects().length === 0)
      return false;
    const style = getComputedStyle(element);
    return (
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none"
    );
  });
  const controls = candidates
    .filter((element) => {
      if (
        !(element instanceof HTMLInputElement) ||
        element.type !== "radio" ||
        !element.name
      )
        return true;
      const group = candidates.filter(
        (candidate): candidate is HTMLInputElement =>
          candidate instanceof HTMLInputElement &&
          candidate.type === "radio" &&
          candidate.name === element.name &&
          candidate.form === element.form,
      );
      return (
        (group.find((candidate) => candidate.checked) ?? group[0]) === element
      );
    })
    .sort((a, b) => {
      // Positive tabindex values precede the normal document-order controls.
      const first = a.tabIndex > 0 ? a.tabIndex : Number.MAX_SAFE_INTEGER;
      const second = b.tabIndex > 0 ? b.tabIndex : Number.MAX_SAFE_INTEGER;
      return first - second;
    });

  event.preventDefault();
  event.stopPropagation();
  if (!controls.length) {
    if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    dialog.focus();
    return;
  }
  const index = controls.indexOf(document.activeElement as HTMLElement);
  const next =
    index < 0
      ? event.shiftKey
        ? controls.length - 1
        : 0
      : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
  controls[next].focus();
}
