/**
 * Runs `onVisible` once, when the node comes within a screen's margin of the viewport — how a
 * picture in a long transcript waits to be scrolled near before it is fetched. Where nothing can
 * tell whether it is on screen (no IntersectionObserver), at once.
 */
export function whenVisible(node: Element, onVisible: () => void): { update(next: () => void): void; destroy(): void } {
  let callback = onVisible;
  if (typeof IntersectionObserver === "undefined") {
    callback();
    return { update() {}, destroy() {} };
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    callback();
  }, { rootMargin: "300px 0px" });
  observer.observe(node);
  return {
    update(next) {
      callback = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}
