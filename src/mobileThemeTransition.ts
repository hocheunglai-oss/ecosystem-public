let snapshotId = 0;

/** Fade the complete static harbour on browsers without native view transitions. */
export function transitionMobileHarbour(commit: () => void) {
  const harbour = document.querySelector(".mobile-harbour-background");
  const scene = harbour?.querySelector(":scope > svg");
  if (!harbour || !scene || typeof harbour.animate !== "function") {
    commit();
    return null;
  }

  const snapshot = document.createElement("div");
  snapshot.className = "mobile-theme-snapshot";
  snapshot.setAttribute("aria-hidden", "true");
  const copy = scene.cloneNode(true) as SVGSVGElement;
  // Keep the copied masks and filters independent of the new scene's SVG defs.
  const prefix = `theme-snapshot-${++snapshotId}-`;
  const ids = new Map([...copy.querySelectorAll("[id]")].map(node => [node.id, `${prefix}${node.id}`]));
  for (const node of copy.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      let value = attribute.value;
      if (attribute.name === "id") value = ids.get(value) ?? value;
      else for (const [before, after] of ids) value = value.replaceAll(`url(#${before})`, `url(#${after})`);
      if (value !== attribute.value) node.setAttribute(attribute.name, value);
    }
  }
  snapshot.append(copy);
  harbour.append(snapshot);
  try {
    commit();
    // Animate the whole captured harbour, never the flag or its lighting separately.
    const animation = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 420, easing: "ease-in-out", fill: "forwards",
    });
    const { width, height } = harbour.getBoundingClientRect();
    const cleanup = () => { observer.disconnect(); snapshot.remove(); };
    const skipTransition = () => { animation.cancel(); cleanup(); };
    const observer = new ResizeObserver(() => {
      const bounds = harbour.getBoundingClientRect();
      // A folding phone can change the crop without leaving the mobile interface.
      if (bounds.width !== width || bounds.height !== height) skipTransition();
    });
    observer.observe(harbour);
    const finished = animation.finished.catch(() => {}).then(cleanup);
    return {
      finished,
      skipTransition,
    };
  } catch (error) {
    snapshot.remove();
    throw error;
  }
}
