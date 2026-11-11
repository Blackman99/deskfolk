/**
 * The seam between the annotated page in a `WebView` and the annotator (`HtmlAnnotator.tsx`). The
 * messenger's picker and viewport helper talk to their parent window with `parent.postMessage`
 * (the picker even hands over a `MessagePort` in it); a web view's page is the top window and has
 * one channel out, `window.nsh.postMessage(string)`. {@link PAGE_SHIM} runs before the page and
 * stands a `parent` in front of it that forwards what carries a 32-hex channel id to that channel
 * as JSON, keeps the port the picker hands over, and passes what the app sends (a `message` event
 * whose data is `{"rbPicker": …}`, swallowed before the page's own listeners) into that port. The
 * validation of what comes out is the messenger's own (`validatePickerMessage`, `viewportMessage`).
 */
import { validatePickerMessage, type PickerReply } from "../../m/annotations/html-picker.ts";
import { viewportMessage, type ViewportMessage } from "../../m/overlays/html-viewport.ts";

/** Injected before the page's scripts (and the picker, which is the first of them). */
export const PAGE_SHIM = `(function(){
  var CH = /^[0-9a-f]{32}$/;
  var port = null;
  var origin = window.parent;
  if (origin !== window) return;
  var parentStandIn = {
    postMessage: function (msg, target, transfer) {
      if (!msg || typeof msg !== "object" || typeof msg.channel !== "string" || !CH.test(msg.channel)) return;
      if (msg.type === "ready" && transfer && transfer[0]) port = transfer[0];
      try { window.nsh.postMessage(JSON.stringify(msg)); } catch (e) {}
    }
  };
  try { Object.defineProperty(window, "parent", { value: parentStandIn, configurable: true }); } catch (e) { return; }
  window.addEventListener("message", function (ev) {
    if (typeof ev.data !== "string" || ev.data.charCodeAt(0) !== 123) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== "object" || !("rbPicker" in m)) return;
    ev.stopImmediatePropagation();
    if (port) { try { port.postMessage(m.rbPicker); } catch (e) {} }
  }, true);
})();`;

/** What the annotator sends the picker, in the shape the shim unpacks. */
export function toPickerWire(message: unknown): string {
  return JSON.stringify({ rbPicker: message });
}

/** The window a page's message is taken to come from: the web view's one page. */
const PAGE = Object.freeze({ page: true });
/** Stands for the port the picker handed over; the shim keeps the real one. */
const PORT = Object.freeze({ postMessage: () => {} });

export type PageSaid = { from: "viewport"; message: ViewportMessage } | { from: "picker"; reply: PickerReply };

/** What the page said (the string `onMessage` gives), checked as the messenger checks a frame's message; null for anything else. */
export function readPageMessage(data: string, channel: string | null, viewportChannel: string | null): PageSaid | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const event = { source: PAGE, data: parsed, ports: [PORT] };
  const view = viewportMessage(event, PAGE, viewportChannel);
  if (view) return { from: "viewport", message: view };
  const reply = validatePickerMessage(event, PAGE, channel);
  return reply ? { from: "picker", reply } : null;
}
