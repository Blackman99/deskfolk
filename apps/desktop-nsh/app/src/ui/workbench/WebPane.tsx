/**
 * In-app WebView pane for external links opened from conversation output on desktop.
 *
 * Keeps a minimal native navigation toolbar (back, forward, reload/stop, address input, copy link,
 * open in system default browser) above NSH's `WebView`. Internal page navigations update the tab's
 * persisted URL and title without feeding the new URL back into `WebView`'s `src` prop (which would
 * trigger a duplicate load).
 */
import {
  cleanup,
  Clipboard,
  effect,
  openUrl,
  platform,
  safeArea,
  signal,
  Text,
  untracked,
  View,
  WebView,
  type WebViewNavigation,
  type WebViewRef,
} from "nsh";
import { Input } from "nsh/base";
import { resolveWebAddressInput, webUrlLabel, webViewUserAgent } from "../../m/workbench/external-link-open.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";

export function WebPane(props: {
  url: string;
  title?: string | null;
  /** `"page"` on a narrow desktop window (shows a Back button to return to the conversation). */
  host?: "pane" | "page";
  onClose?: () => void;
  onNavigate?: (next: { url: string; title: string | null }) => void;
}) {
  const t = () => copy().pane;
  let web: WebViewRef | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReportedUrl = props.url;

  /** The URL explicitly requested to load in `<WebView src={...}>`. */
  const loadedSrc = signal(props.url);
  /** The current URL shown in the address bar and used by Copy / Open in browser. */
  const currentUrl = signal(props.url);
  const addressDraft = signal(props.url);
  const loading = signal(Boolean(props.url));
  const canGoBack = signal(false);
  const canGoForward = signal(false);
  const errorMessage = signal<string | null>(null);
  const webviewAvailable = signal<boolean | null>(null);
  const copied = signal(false);

  cleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  void WebView.available()
    .then((ok) => webviewAvailable.set(ok))
    .catch(() => webviewAvailable.set(true));

  // If the tab is retargeted externally to a different URL, load that URL.
  effect(() => {
    const incoming = props.url;
    if (incoming && incoming !== lastReportedUrl) {
      lastReportedUrl = incoming;
      untracked(() => {
        loadedSrc.set(incoming);
        currentUrl.set(incoming);
        addressDraft.set(incoming);
        loading.set(true);
        errorMessage.set(null);
      });
    }
  });

  function applyNavigation(e: WebViewNavigation): void {
    loading.set(e.loading);
    canGoBack.set(e.canGoBack);
    canGoForward.set(e.canGoForward);
    const nextUrl = e.url?.trim();
    if (nextUrl && /^https?:\/\//i.test(nextUrl)) {
      const changed = nextUrl !== currentUrl();
      currentUrl.set(nextUrl);
      if (changed) addressDraft.set(nextUrl);
      const nextTitle = e.title?.trim() || null;
      if (nextUrl !== lastReportedUrl || nextTitle !== (props.title ?? null)) {
        lastReportedUrl = nextUrl;
        props.onNavigate?.({ url: nextUrl, title: nextTitle });
      }
    } else if (e.title?.trim() && e.title.trim() !== (props.title ?? null)) {
      props.onNavigate?.({ url: currentUrl(), title: e.title.trim() });
    }
  }

  function submitAddress(): void {
    const target = resolveWebAddressInput(addressDraft());
    if (!target) {
      addressDraft.set(currentUrl());
      return;
    }
    errorMessage.set(null);
    lastReportedUrl = target;
    currentUrl.set(target);
    addressDraft.set(target);
    loading.set(true);
    if (target === loadedSrc() && web) web.reload();
    else loadedSrc.set(target);
    props.onNavigate?.({ url: target, title: null });
  }

  function openInBrowser(): void {
    const url = currentUrl();
    if (url) void openUrl(url).catch(() => undefined);
  }

  function copyLink(): void {
    const url = currentUrl();
    if (!url) return;
    void Clipboard.writeText(url).catch(() => undefined);
    copied.set(true);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.set(false);
      copyTimer = null;
    }, 1800);
  }

  const isPage = () => props.host === "page";

  return (
    <View testID="web-pane" class="flex-1 min-h-0 min-w-0 flex-col bg-pane">
      <View
        testID="web-pane-toolbar"
        class="flex-row items-center gap-[4px] px-2 py-[5px] border-b border-line shrink-0 bg-pane"
        style={isPage() ? { paddingTop: 5 + safeArea().top } : undefined}
      >
        <If when={isPage() && props.onClose}>
          <IconButton testID="web-pane-close" icon="chevron-left" size="sm" label={copy().common.back} onPress={() => props.onClose?.()} />
        </If>
        <IconButton
          testID="web-pane-back"
          icon="arrow-left"
          size="sm"
          label={t().webBack}
          disabled={!canGoBack()}
          onPress={() => web?.goBack()}
        />
        <IconButton
          testID="web-pane-forward"
          icon="arrow-right"
          size="sm"
          label={t().webForward}
          disabled={!canGoForward()}
          onPress={() => web?.goForward()}
        />
        <IconButton
          testID="web-pane-reload"
          icon={loading() ? "x" : "refresh"}
          size="sm"
          label={loading() ? t().webStop : t().webReload}
          disabled={!loadedSrc()}
          onPress={() => {
            if (loading()) web?.stopLoading();
            else {
              errorMessage.set(null);
              web?.reload();
            }
          }}
        />
        <View class="flex-1 min-w-0 mx-[4px]">
          <Input
            testID="web-pane-address"
            value={addressDraft()}
            onChange={(e) => addressDraft.set(e.value)}
            onSubmit={submitAddress}
            submitBehavior="submit"
            autoFocus={!props.url}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t().webAddressPlaceholder}
            accessibilityLabel={t().webAddressLabel}
            class="h-[28px] px-[10px] rounded-(--radius-control-sm) bg-chip border border-chip-line text-[12px] text-ink"
          />
        </View>
        <IconButton
          testID="web-pane-copy"
          icon={copied() ? "check" : "copy"}
          size="sm"
          label={copied() ? t().webUrlCopied : t().webCopyUrl}
          disabled={!currentUrl()}
          onPress={copyLink}
        />
        <IconButton
          testID="web-pane-open-browser"
          icon="external"
          size="sm"
          label={t().webOpenBrowser}
          disabled={!currentUrl()}
          onPress={openInBrowser}
        />
      </View>

      <If when={loading() && Boolean(loadedSrc()) && webviewAvailable() !== false && !errorMessage()}>
        <View testID="web-pane-loading" class="h-[2px] bg-brand/70 shrink-0" />
      </If>

      <If
        when={webviewAvailable() !== false}
        else={
          <View testID="web-pane-unavailable" class="flex-1 min-h-0 items-center justify-center p-6 gap-3">
            <View class="w-[40px] h-[40px] rounded-full bg-chip items-center justify-center">
              <Icon name="globe" size={20} class="tint-ink-muted" />
            </View>
            <Text class="text-[13px] text-ink-muted text-center max-w-[340px]">{t().webUnavailable}</Text>
            <If when={currentUrl()}>
              {(u) => (
                <>
                  <Text class="text-[12px] font-mono text-ink-muted line-clamp-1 max-w-[360px]">{webUrlLabel(u())}</Text>
                  <Button size="sm" variant="primary" icon="external" testID="web-pane-fallback-browser" onPress={openInBrowser}>
                    {t().webOpenBrowser}
                  </Button>
                </>
              )}
            </If>
          </View>
        }
      >
        <If
          when={loadedSrc()}
          else={
            <View testID="web-pane-empty" class="flex-1 min-h-0 items-center justify-center p-6 gap-3">
              <View class="w-[44px] h-[44px] rounded-full bg-chip items-center justify-center">
                <Icon name="globe" size={20} class="tint-ink-muted" />
              </View>
              <Text class="text-[14px] font-semibold text-ink">{t().newWeb}</Text>
              <Text class="text-[12px] text-ink-muted text-center max-w-[320px]">{t().webEmptyHint}</Text>
            </View>
          }
        >
          {(src) => (
            <View class="relative flex-1 min-h-0 min-w-0">
              <WebView
                testID="web-pane-webview"
                src={src()}
                userAgent={webViewUserAgent(platform.os)}
                accessibilityLabel={props.title || webUrlLabel(currentUrl())}
                desktop={{ allowsBackForwardNavigationGestures: true }}
                onLoadStart={(e) => {
                  errorMessage.set(null);
                  applyNavigation(e);
                }}
                onLoad={(e) => {
                  errorMessage.set(null);
                  applyNavigation(e);
                }}
                onNavigationStateChange={(e) => applyNavigation(e)}
                onError={(e) => {
                  loading.set(false);
                  if (e.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
                    webviewAvailable.set(false);
                    return;
                  }
                  errorMessage.set(e.message || t().webLoadError);
                }}
                ref={(node) => {
                  web = node;
                }}
                class="flex-1 w-full h-full"
              />
              <If when={errorMessage()}>
                {(msg) => (
                  <View testID="web-pane-error" class="absolute inset-0 bg-pane items-center justify-center p-6 gap-3">
                    <View class="w-[40px] h-[40px] rounded-full bg-chip items-center justify-center">
                      <Icon name="alert-circle" size={20} class="tint-ink-muted" />
                    </View>
                    <Text class="text-[14px] font-semibold text-ink">{t().webLoadError}</Text>
                    <Text class="text-[12px] text-ink-muted text-center max-w-[360px]">{msg()}</Text>
                    <View class="flex-row items-center gap-2 mt-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="refresh"
                        testID="web-pane-retry"
                        onPress={() => {
                          errorMessage.set(null);
                          web?.reload();
                        }}
                      >
                        {t().webReload}
                      </Button>
                      <Button size="sm" variant="primary" icon="external" testID="web-pane-error-browser" onPress={openInBrowser}>
                        {t().webOpenBrowser}
                      </Button>
                    </View>
                  </View>
                )}
              </If>
            </View>
          )}
        </If>
      </If>
    </View>
  );
}
