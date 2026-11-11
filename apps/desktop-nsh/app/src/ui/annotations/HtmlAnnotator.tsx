/**
 * An HTML page and its annotations (`HtmlAnnotator.svelte`). The page runs in NSH's `WebView` (the
 * one place the app may use one) as the messenger runs it in a sandboxed iframe: in annotate mode
 * the messenger's picker (`annotatorSource`) goes in front of it, hover outlines the element under
 * the pointer, a click chooses, ↑ ↓ move to the enclosing or first inner element, Enter chooses and
 * Esc leaves; the outlines and numbers of existing marks are drawn by the picker in the page. The
 * picker's `parent.postMessage` and its `MessagePort` are carried over `window.nsh.postMessage` by
 * a shim (`html-bridge.ts`); everything it says is validated as the messenger validates it.
 *
 * The page sits in a small device (desktop / tablet / phone) shrunk to fit; the device switcher and
 * 全屏 are under it. Full screen is the preview laid out as a `position: fixed` box of the window.
 *
 * Differences from the messenger: the chosen device is remembered in the app's `Storage` (not
 * `localStorage`); no mark chip is scrolled into view when it is focused (the row is a plain
 * horizontal scroll); the page is not given the keyboard on entering annotate mode (a web view
 * takes focus from a press in it).
 */
import { cleanup, computed, effect, keymap, Scroll, signal, Storage, Text, untracked, View, WebView, type WebViewRef } from "nsh";
import type { Annotation, HtmlElementAnchor } from "@real-bot/protocol";
import { annotatorSource, focusMessage, marksMessage, navMessage, newChannel, pickerMarks, type PickerMark } from "../../m/annotations/html-picker.ts";
import type { EncodedCrop } from "../../m/annotations/region-box.ts";
import {
  ENLARGED_MAX_SCALE,
  VIEWPORT_DEVICES,
  fitViewport,
  pageLayoutWidth,
  viewportHelperMarkup,
  viewportMeta,
  type ViewportDevice,
} from "../../m/overlays/html-viewport.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { cssColor } from "../styles";
import { tip } from "../tip";
import { PAGE_SHIM, readPageMessage, toPickerWire } from "./html-bridge";

/** Every string this annotator shows; the preview hands them in from its copy (`annotHtml`). */
export type HtmlAnnotatorLabels = {
  /** The bar's hint while choosing an element. */
  hint: string;
  /** The keyboard help beside the hint (hidden on phones). */
  keysHint: string;
  /** The bar's hint while a chosen element waits for its remark. */
  pendingHint: string;
  /** The button that moves the outline to the enclosing element. */
  outer: string;
  /** The button that moves the outline to the first element inside. */
  inner: string;
  /** The accessible name of the row of numbered marks. */
  marks: string;
  /** The accessible name of one numbered mark. */
  markLabel: (n: number) => string;
  /** Added to the tooltip of a mark whose file changed since it was written. */
  stale: string;
  /** Added to the tooltip of a mark the page no longer has. */
  notFound: string;
  /** The bar's hint when the picker never answered: the page's scripts are blocked here. */
  blocked: string;
  /** The device switcher under the page: its accessible name and each device's name. */
  viewport: {
    group: string;
    /** The size's tooltip when a phone or tablet zooms out on a page laid out wider than it. */
    zoomed: (width: number) => string;
    /** The full-screen button, before and while the preview fills the window. */
    enlarge: string;
    shrink: string;
  } & Record<ViewportDevice, string>;
};

/** What a test (or a host) can do to a running annotator: feed it what the page would say. */
export type HtmlAnnotatorHandle = {
  /** The page said this (the string `onMessage` gives). */
  receive: (data: string) => void;
  /** This build's picker channel; null while the page runs without the picker. */
  channel: () => string | null;
  /** This build's helper channel. */
  viewportChannel: () => string | null;
  /** What went to the page, oldest first (the last 50); read in a reactive context it follows what is sent. */
  sent: () => string[];
};

const FLASH_MS = 1400;
const DEVICE_KEY = "real-bot-html-viewport";
const BAR_H = 30;
const BAR_H_PHONE = 44;

/** The device this viewer last picked, for the next preview opened. */
const lastDevice = signal<ViewportDevice>("desktop");
let deviceLoaded = false;

type Build = { id: number; source: string };
type Drawn = { row: Annotation; n: number };

export function HtmlAnnotator(props: {
  /** The file's raw source. */
  html: string;
  scheme: "light" | "dark";
  /** The page's title (the path). */
  title: string;
  /** This file's html_element rows, in display order: numbered 1..n. */
  annotations: Annotation[];
  /** Scroll the page to this one and flash it when it changes (annotate mode only). */
  focusId: string | null;
  /** Bumped on every request to go to `focusId`, so the one already focused is revealed again. */
  focusSeq?: number;
  /** Annotate mode: the picker is injected, hover outlines, a click chooses. */
  active: boolean;
  /** Whether a new annotation may be started at all; existing ones are drawn either way. */
  enabled: boolean;
  labels: HtmlAnnotatorLabels;
  /** An element was chosen. There is never a crop: the page's pixels are not ours. */
  onDraft: (draft: { anchor: HtmlElementAnchor; crop?: () => Promise<EncodedCrop | null> }) => void;
  /** A numbered mark in the bar was pressed. */
  onPick: (id: string) => void;
  /** The anchor waiting for its remark: drawn in the page with a heavier outline. */
  pending?: HtmlElementAnchor | null;
  /** Another element was chosen (click, ↑ ↓, 外层 / 内层) while one was pending. Without it, a new draft. */
  onPendingChange?: (anchor: HtmlElementAnchor) => void;
  /** Escape while choosing or with an anchor pending, in the page or in the app. */
  onCancel?: () => void;
  /** After the file changed: the rows whose element the page no longer has (with the same text). */
  onMissing?: (ids: string[]) => void;
  /** How long after the page loaded the picker may take to say hello before the bar says it is blocked. */
  readyWaitMs?: number;
  /** Receives the handle once, when the annotator is made. */
  handle?: (handle: HtmlAnnotatorHandle) => void;
  testID?: string;
}) {
  let web: WebViewRef | null = null;
  const build = signal<Build | null>(null);
  /** Bumped when the picker exited on its own, so the page reloads (with a new one while still annotating). */
  const reloads = signal(0);
  const portReady = signal(false);
  const flashId = signal<string | null>(null);
  const notFound = signal<ReadonlySet<string>>(new Set());
  const blocked = signal(false);
  const contentWidth = signal<number | null>(null);
  const enlarged = signal(false);
  const roomWidth = signal(0);
  const roomHeight = signal(0);
  const stageWidth = signal(0);
  let buildId = 0;
  let channel: string | null = null;
  let viewportChannel: string | null = null;
  let rev = 0;
  let idsByN = new Map<number, string>();
  let checkedNs = new Set<number>();
  let sentKey = "";
  let lastMissing = "";
  let focusN = 0;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const sent: string[] = [];
  const sentCount = signal(0);

  const device = () => lastDevice();
  const injecting = () => props.active || props.pending != null;
  const picking = () => props.active && props.enabled;
  const marks = () => pickerMarks(props.annotations);
  // Read once per page, from its head: run on every layout, the scans of a 20 MB page held the
  // window for five seconds (QuickJS regexes, a pass each).
  const pageViewport = computed(() => viewportMeta(headOf(props.html)));
  const layout = () =>
    fitViewport(
      device(),
      { width: roomWidth(), height: roomHeight() },
      pageLayoutWidth(device(), pageViewport(), contentWidth()),
      enlarged() ? ENLARGED_MAX_SCALE : 1,
    );
  const drawn = (): Drawn[] =>
    props.annotations
      .map((row, i) => ({ row, n: i + 1 }))
      .filter(({ row }) => row.anchor_kind === "html_element" && row.stale?.kind !== "missing");
  const barHeight = () => (narrowWindow() ? BAR_H_PHONE : BAR_H);

  if (!deviceLoaded) {
    deviceLoaded = true;
    void Storage.getItem(DEVICE_KEY)
      .then((raw) => {
        if (raw && (VIEWPORT_DEVICES as readonly string[]).includes(raw)) lastDevice.set(raw as ViewportDevice);
      })
      .catch(() => undefined);
  }

  function toPage(wire: string): void {
    sent.push(wire);
    if (sent.length > 50) sent.shift();
    sentCount.set(sentCount() + 1);
    try {
      web?.postMessage(wire);
    } catch {
      // The page went away.
    }
  }
  const post = (message: unknown) => toPage(toPickerWire(message));

  function clearReadyWait(): void {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  }

  function dropPort(): void {
    portReady.set(false);
    sentKey = "";
  }

  // The page's build: a new one (a new web view) whenever the file, the theme, annotate mode or the
  // device changes, or the picker left on its own.
  effect(() => {
    const raw = props.html;
    const scheme = props.scheme;
    const on = injecting();
    const touch = device() !== "desktop";
    void reloads();
    const ch = on ? newChannel() : null;
    const vch = newChannel();
    const viewport = viewportHelperMarkup({ channel: vch, touch, nonce: null });
    const source = annotatorSource(raw, { scheme, nonce: null, channel: ch, viewport });
    untracked(() => {
      dropPort();
      clearReadyWait();
      blocked.set(false);
      channel = ch;
      viewportChannel = vch;
      contentWidth.set(null);
      buildId += 1;
      build.set({ id: buildId, source });
    });
  });

  effect(() => {
    const list = marks();
    const pendingSelector = props.pending?.selector ?? null;
    const choosing = picking();
    if (!portReady() || !channel) return;
    untracked(() => sendMarks(list, pendingSelector, choosing));
  });

  effect(() => {
    const id = props.focusId;
    void props.focusSeq;
    if (!id) return;
    untracked(() => focusOn(id));
  });

  // A row that is no longer re-checked (deleted, or its file is back to what was annotated) is not
  // missing any more, whether or not the page is open in annotate mode.
  effect(() => {
    const checked = new Set(marks().filter((m) => m.check).map((m) => props.annotations[m.n - 1]?.id));
    untracked(() => {
      const kept = [...notFound()].filter((id) => checked.has(id));
      if (kept.length !== notFound().size) reportMissing(kept);
    });
  });

  keymap.bind(
    "escape",
    () => {
      if (enlarged()) {
        enlarged.set(false);
        return;
      }
      if (props.onCancel && (props.active || props.pending)) props.onCancel();
    },
    { when: "always" },
  );

  cleanup(() => {
    clearReadyWait();
    if (flashTimer) clearTimeout(flashTimer);
  });

  function sendMarks(list: PickerMark[], pendingSelector: string | null, choosing: boolean): void {
    if (!channel) return;
    // A snapshot that hands in new row objects with the same content would otherwise redraw the
    // page's marks (cutting a flash short) and run its re-anchor check again for nothing.
    const ids = props.annotations.map((row) => row.id);
    const key = JSON.stringify([list, pendingSelector, choosing, ids]);
    if (key !== sentKey) {
      sentKey = key;
      rev += 1;
      idsByN = new Map(ids.map((id, i) => [i + 1, id]));
      checkedNs = new Set(list.filter((m) => m.check).map((m) => m.n));
      post(marksMessage(channel, list, { pending: pendingSelector, picking: choosing, rev }));
    }
    if (focusN) {
      post(focusMessage(channel, focusN));
      focusN = 0;
    }
  }

  function focusOn(id: string): void {
    const n = props.annotations.findIndex((row) => row.id === id) + 1;
    if (n < 1) return;
    flashId.set(id);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashId.set(null), FLASH_MS);
    if (portReady() && channel) post(focusMessage(channel, n));
    else if (injecting()) focusN = n;
  }

  function onPageMessage(data: string): void {
    const said = readPageMessage(data, channel, viewportChannel);
    if (!said) return;
    if (said.from === "viewport") {
      // Only the first: widening the layout can widen a page sized off the viewport, and so on.
      if (said.message.type === "content") {
        if (contentWidth() === null) contentWidth.set(said.message.width);
      } else enlarged.set(false);
      return;
    }
    const reply = said.reply;
    switch (reply.type) {
      case "ready":
        dropPort();
        clearReadyWait();
        blocked.set(false);
        portReady.set(true);
        return;
      case "pick":
        chosen(reply.anchor);
        return;
      case "cancel":
        // The picker has exited and cleaned up; the page reloads, without it once annotate mode is off.
        dropPort();
        reloads.set(reloads() + 1);
        props.onCancel?.();
        return;
      case "missing":
        missingAnswer(reply.ns, reply.rev);
        return;
    }
  }

  function chosen(anchor: HtmlElementAnchor): void {
    if (!props.enabled || (!props.active && !props.pending)) return;
    // The remark is written in the pane, under the full-screen preview.
    enlarged.set(false);
    if (props.pending && props.onPendingChange) props.onPendingChange(anchor);
    else props.onDraft({ anchor });
  }

  function missingAnswer(ns: number[], answered: number): void {
    if (answered !== rev) return;
    const ids = ns
      .filter((n) => checkedNs.has(n))
      .map((n) => idsByN.get(n))
      .filter((id): id is string => typeof id === "string");
    reportMissing(ids);
  }

  /** Remember which rows the page could not find, and tell the preview when that set changed. */
  function reportMissing(ids: string[]): void {
    notFound.set(new Set(ids));
    const key = [...ids].sort().join("\n");
    if (key === lastMissing) return;
    lastMissing = key;
    props.onMissing?.(ids);
  }

  function onPageLoad(): void {
    if (!injecting() || portReady() || !channel) return;
    const waited = channel;
    clearReadyWait();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!portReady() && channel === waited) blocked.set(true);
    }, props.readyWaitMs ?? 2000);
  }

  function nav(dir: "up" | "down"): void {
    if (portReady() && channel) post(navMessage(channel, dir));
  }

  function pickDevice(next: ViewportDevice): void {
    if (next === device()) return;
    lastDevice.set(next);
    void Storage.setItem(DEVICE_KEY, next).catch(() => undefined);
  }

  function chipTitle(row: Annotation, n: number): string {
    const lines = [`${n}. ${row.body}`];
    if (notFound().has(row.id)) lines.push(props.labels.notFound);
    else if (row.stale) lines.push(props.labels.stale);
    return lines.join("\n");
  }

  props.handle?.({
    receive: onPageMessage,
    channel: () => channel,
    viewportChannel: () => viewportChannel,
    sent: () => (sentCount(), [...sent]),
  });

  const dark = () => props.scheme === "dark";

  return (
    <View
      testID={props.testID ?? "html-annotator"}
      accessibilityLabel={props.title}
      class={`min-w-0 flex-1 gap-[6px] ${enlarged() ? "bg-bg" : ""}`}
      style={
        enlarged()
          ? { position: "fixed", left: 0, top: 0, right: 0, bottom: 0, zIndex: 1000, padding: 12, overflow: "hidden" }
          : undefined
      }
    >
      <If when={injecting()}>
        <View
          testID="html-annot-bar"
          class={`flex-row items-center gap-[6px] min-w-0 px-[6px] py-1 min-h-[32px] border border-accent-border rounded-(--radius-md) bg-accent-tint ${
            narrowWindow() ? "flex-wrap" : ""
          }`}
        >
          <If when={drawn().length > 0}>
            <Scroll horizontal class="shrink-0" style={{ maxWidth: narrowWindow() ? "100%" : "50%" }}>
              <View role="list" accessibilityLabel={props.labels.marks} class="flex-row items-center gap-1">
                <Each of={drawn()} key={(d: Drawn) => d.row.id}>
                  {(d: () => Drawn) => (
                    <View
                      role="button"
                      testID={`html-chip-${d().row.id}`}
                      accessibilityLabel={props.labels.markLabel(d().n)}
                      tooltip={tip(chipTitle(d().row, d().n))}
                      onPress={() => props.onPick(d().row.id)}
                      class={`cursor-pointer select-none items-center justify-center rounded-full border px-[6px] ${narrowWindow() ? "min-w-[40px] min-h-[40px]" : "min-w-[22px] h-[22px]"} ${
                        d().row.status === "draft"
                          ? "bg-pane border-dotted border-brand"
                          : d().row.status === "resolved"
                            ? "bg-btn-secondary-bg border-line-hover"
                            : "bg-brand border-brand"
                      } ${d().row.stale != null ? "border-dashed" : ""} ${notFound().has(d().row.id) ? "opacity-55" : ""} ${
                        flashId() === d().row.id ? "border-2" : ""
                      }`}
                    >
                      <Text
                        class={`text-[11px] ${
                          d().row.status === "draft" ? "text-brand" : d().row.status === "resolved" ? "text-ink-muted" : "text-on-accent"
                        } ${notFound().has(d().row.id) ? "line-through" : ""}`}
                      >
                        {String(d().n)}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </If>
          <Text testID="html-annot-hint" class="flex-1 min-w-0 text-[12px] text-ink line-clamp-1">
            {props.pending ? props.labels.pendingHint : picking() ? (blocked() ? props.labels.blocked : props.labels.hint) : ""}
          </Text>
          <If when={picking() && !props.pending && !blocked() && !narrowWindow()}>
            <Text class="shrink-0 text-[11px] text-ink-muted">{props.labels.keysHint}</Text>
          </If>
          <If when={picking()}>
            <NavButton testID="html-nav-outer" label={props.labels.outer} disabled={!portReady()} onPress={() => nav("up")} />
            <NavButton testID="html-nav-inner" label={props.labels.inner} disabled={!portReady()} onPress={() => nav("down")} />
          </If>
        </View>
      </If>
      <View
        testID="html-stage"
        class="relative flex-1 min-h-[280px] overflow-hidden border border-line rounded-(--radius-md) bg-bg"
        onLayout={(e) => stageWidth.set(e.bounds.size.width)}
      >
        <View
          class="absolute items-center justify-center"
          style={{ left: 16, top: 16, right: 16, bottom: barHeight() + 20 }}
          onLayout={(e) => {
            roomWidth.set(e.bounds.size.width);
            roomHeight.set(e.bounds.size.height);
          }}
        >
          <View testID={`html-device-${device()}`} class="items-center" style={{ width: layout().frame.width, height: layout().frame.height }}>
            <View
              class="overflow-hidden"
              style={{
                paddingTop: layout().bezel.top,
                paddingBottom: layout().bezel.bottom,
                paddingLeft: layout().bezel.side,
                paddingRight: layout().bezel.side,
                backgroundColor: dark() ? "#0a0c10" : "#1c1e23",
                borderTopLeftRadius: layout().radius,
                borderTopRightRadius: layout().radius,
                borderBottomLeftRadius: device() === "desktop" ? layout().radius * 0.3 : layout().radius,
                borderBottomRightRadius: device() === "desktop" ? layout().radius * 0.3 : layout().radius,
              }}
            >
              <View
                testID="html-device-screen"
                class="relative bg-pane overflow-hidden"
                style={{
                  width: layout().screen.width,
                  height: layout().screen.height,
                  borderRadius: Math.max(2, layout().radius - layout().bezel.side),
                  boxShadow: picking() ? `0 0 0 2px ${cssColor("var(--accent)")}` : undefined,
                }}
              >
                <Each of={build() ? [build()!] : []} key={(b: Build) => String(b.id)}>
                  {(b: () => Build) => (
                    <WebView
                      testID="html-frame"
                      accessibilityLabel={props.title}
                      html={b().source}
                      injectedJavaScriptBeforeContentLoaded={PAGE_SHIM}
                      onMessage={(e) => onPageMessage(e.data)}
                      onLoad={onPageLoad}
                      ref={(node) => {
                        web = node;
                      }}
                      class="absolute"
                      style={{
                        left: 0,
                        top: 0,
                        width: layout().page.width,
                        height: layout().page.height,
                        transform: `scale(${layout().page.scale})`,
                        transformOrigin: "top left",
                      }}
                    />
                  )}
                </Each>
              </View>
            </View>
            <If when={device() === "desktop"}>
              <View
                style={{
                  width: "100%",
                  height: layout().base,
                  backgroundColor: dark() ? "#3a3e46" : "#b1b5bd",
                  borderBottomLeftRadius: layout().base * 2,
                  borderBottomRightRadius: layout().base * 2,
                }}
              />
            </If>
          </View>
        </View>
        <View class="absolute left-0 right-0 items-center" style={{ bottom: 10, pointerEvents: "box-none" }}>
          <View
            role="group"
            testID="html-viewport-bar"
            accessibilityLabel={props.labels.viewport.group}
            class="flex-row items-center gap-[2px] px-[3px] border border-line rounded-full bg-pane"
            style={{ height: barHeight(), maxWidth: Math.max(0, stageWidth() - 24) }}
          >
            <Each of={[...VIEWPORT_DEVICES]} key={(d: ViewportDevice) => d}>
              {(option: () => ViewportDevice) => (
                <View
                  role="button"
                  testID={`html-device-${option()}-option`}
                  accessibilityLabel={props.labels.viewport[option()]}
                  accessibilityState={{ pressed: device() === option() }}
                  tooltip={tip(props.labels.viewport[option()])}
                  onPress={() => pickDevice(option())}
                  class={`cursor-pointer select-none group flex-row items-center justify-center gap-[5px] rounded-full ${narrowWindow() ? "min-w-[40px]" : ""} ${
                    stageWidth() <= 440 ? "px-2" : "pl-2 pr-[9px]"
                  } ${device() === option() ? "bg-accent-tint" : ""}`}
                  style={{ height: barHeight() - 6 }}
                >
                  <Icon
                    name={option() === "desktop" ? "monitor" : option() === "tablet" ? "tablet" : "smartphone"}
                    size={16}
                    class={device() === option() ? "tint-brand" : "tint-ink-secondary group-hover:tint-brand"}
                  />
                  <If when={stageWidth() > 440}>
                    <Text class={`text-[12px] font-semibold ${device() === option() ? "text-brand" : "text-ink-secondary"}`}>
                      {props.labels.viewport[option()]}
                    </Text>
                  </If>
                </View>
              )}
            </Each>
            <If when={stageWidth() > 300}>
              <Text
                testID="html-viewport-size"
                tooltip={layout().page.width !== layout().width ? tip(props.labels.viewport.zoomed(Math.round(layout().page.width))) : undefined}
                class="ml-[6px] pl-[9px] pr-[6px] border-l border-line text-[11px] text-ink-muted"
              >
                {`${layout().width} × ${layout().height} · ${Math.round(layout().scale * 100)}%`}
              </Text>
            </If>
            <View
              role="button"
              testID="html-enlarge"
              accessibilityLabel={enlarged() ? props.labels.viewport.shrink : props.labels.viewport.enlarge}
              accessibilityState={{ pressed: enlarged() }}
              tooltip={tip(enlarged() ? props.labels.viewport.shrink : props.labels.viewport.enlarge)}
              onPress={() => enlarged.set(!enlarged())}
              class="cursor-pointer select-none group items-center justify-center px-[7px] border-l border-line"
              style={{ height: barHeight() - 6 }}
            >
              <Icon name={enlarged() ? "minimize" : "maximize"} size={16} class="tint-ink-secondary group-hover:tint-brand" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

function NavButton(props: { testID: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityState={{ disabled: props.disabled }}
      onPress={props.disabled ? undefined : props.onPress}
      class={`cursor-pointer select-none shrink-0 items-center justify-center px-[10px] border border-line rounded-(--radius-sm) bg-btn-secondary-bg ${
        narrowWindow() ? "min-w-[40px] min-h-[40px]" : "h-6"
      } ${props.disabled ? "opacity-50" : "hover:border-line-hover"}`}
    >
      <Text class="text-[12px] text-ink">{props.label}</Text>
    </View>
  );
}

/** How far into a page without a `<body>` its viewport `<meta>` is looked for. */
const HEAD_SCAN = 256 * 1024;

/**
 * The part of a page its viewport `<meta>` is in: up to its `<body>`, or its first 256 KiB when it
 * has none. The rest (a report's megabytes of data, say) cannot hold it.
 */
export function headOf(html: string): string {
  const at = [html.indexOf("<body"), html.indexOf("<BODY"), html.indexOf("<Body")].filter((i) => i >= 0);
  return html.slice(0, at.length > 0 ? Math.min(...at) : HEAD_SCAN);
}
