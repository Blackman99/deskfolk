/**
 * Stops a phone or iPad from scaling the remote app.
 *
 * Android Chrome honors `user-scalable=no` in the viewport. iOS Safari has ignored that since
 * iOS 10, and a pinch still scales the page. Cancelling `gesturestart` is what actually stops
 * it there. The event is not swallowed: a PDF listens for the same gesture and zooms its own
 * pages, and the Mac screen's pinch is a touch recognizer of its own. `stopPropagation` would
 * take those away.
 */
const locked = new WeakSet<EventTarget>();

export function lockPageZoom(doc: Document = document): void {
  if (locked.has(doc)) return;
  locked.add(doc);
  const block = (event: Event) => {
    event.preventDefault();
  };
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    doc.addEventListener(type, block, { passive: false });
  }
}
