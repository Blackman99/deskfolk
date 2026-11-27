/**
 * Settings › Behavior: how external web links in conversation output open on the desktop —
 * in-app WebView (default) or the system default browser.
 *
 * Test ids: `settings-card-external-link`, `external-link-open-mode`,
 * `external-link-open-webview`, `external-link-open-browser`.
 */
import { View } from "nsh";
import { copy } from "../../runtime";
import { externalLinkOpen } from "../../m/workbench/external-link-open-store.svelte.ts";
import { Icon } from "../Icon";
import { InterfaceSegmented } from "./InterfaceSegmented";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { SettingsRow } from "./SettingsRow";

export function ExternalLinkCard() {
  const t = () => copy().settings;
  return (
    <SettingsCard testID="settings-card-external-link">
      <SettingsCardHeader
        title={t().externalLinksTitle}
        subtitle={t().externalLinksSubtitle}
        icon={
          <View class="w-[30px] h-[30px] rounded-(--radius-md) bg-accent-tint items-center justify-center shrink-0">
            <Icon name="external" class="tint-brand" />
          </View>
        }
      />
      <View class="flex-col border-t border-line-subtle mt-1">
        <SettingsRow
          title={t().externalLinksMode}
          titleId="external-link-open-label"
          desc={t().externalLinksModeDesc}
          last
        >
          <InterfaceSegmented
            testID="external-link-open-mode"
            ariaLabel={t().externalLinksMode}
            value={externalLinkOpen.mode}
            onPick={(value) => externalLinkOpen.set(value)}
            options={[
              { value: "webview", label: t().externalLinksWebview, testID: "external-link-open-webview" },
              { value: "browser", label: t().externalLinksBrowser, testID: "external-link-open-browser" },
            ]}
          />
        </SettingsRow>
      </View>
    </SettingsCard>
  );
}
