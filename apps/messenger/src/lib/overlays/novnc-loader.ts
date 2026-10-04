/**
 * noVNC, loaded without its import-time H.264 probe.
 *
 * `core/util/browser.js` awaits, at module top level, a test decode through `VideoDecoder` whose
 * `flush()` has no timeout. Where that promise never settles (a phone's hardware decoder), the
 * import never finishes and the page sits on "connecting" without a request ever reaching the Mac.
 * Screen Sharing never sends H.264, so the probe answers a question this page never asks: the
 * interface is hidden for as long as the module takes to evaluate, which makes noVNC skip it.
 */
export async function loadNoVnc<T>(importer: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const scope = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  let hidden = false;
  if (descriptor?.configurable) hidden = delete scope.VideoDecoder;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      importer(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("novnc_load_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (hidden && descriptor) Object.defineProperty(globalThis, "VideoDecoder", descriptor);
  }
}
