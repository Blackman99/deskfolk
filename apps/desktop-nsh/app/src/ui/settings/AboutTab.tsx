/**
 * Settings › About (`settings/AboutTab.svelte`): the app's mark, name, version and, where the shell
 * can ask, the update check and the in-app install. The checker is the messenger's `updateChecker`
 * (`m/update-checker.svelte.ts`); the shell starts it, as `routes/+page.svelte` does, and this card
 * only reads it and calls its actions. Where the shell does not answer a command (`check_for_update`,
 * `can_install_update`, `update_install_state`, `start_update_install`, `cancel_update_install`) the
 * checker's own error state shows ("the check failed"), as it does in the messenger.
 *
 * Props: `locale` (picks the language of the release notes). Test ids: `about-version`,
 * `about-check-update`, `about-update-failed`, `about-up-to-date`, `about-update-banner`,
 * `about-install`, `about-install-cancel`, `about-install-failed`, `about-update-install`,
 * `about-update-download`, `about-update-notes`, `about-update-ignore`.
 */
import { Progress } from "nsh/base";
import { Scroll, Text, View } from "nsh";
import { copy } from "../../runtime";
import { updateChecker } from "../../m/update-checker.svelte.ts";
import { formatBytes, installErrorCopyKey, installPercent, installPhaseCopyKey } from "../../m/updates.ts";
import { localeSection, releaseNoteGroups } from "../../m/settings/release-notes.ts";
import { BrandMark } from "../BrandMark";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { SettingsCard } from "./SettingsCard";
import { widthAtMost } from "../../platform/viewport";

export function AboutTab(props: { locale: "zh" | "en" }) {
  const t = () => copy();
  const checker = updateChecker;
  /** What the release body says changed, drawn in the About card instead of only linked to. */
  const updateChanges = () =>
    releaseNoteGroups(localeSection(checker.result?.notes, props.locale)).map((group, index) => ({
      ...group,
      key: `${index}`,
      items: group.items.map((text, at) => ({ text, key: `${index}:${at}` })),
    }));
  /** The in-app download and swap, as the card draws it: phase, bar, failure. */
  const installPhaseKey = () => installPhaseCopyKey(checker.install.phase);
  const installLabel = () => {
    const key = installPhaseKey();
    return key ? t().settings[key] : "";
  };
  const installPercentValue = () => installPercent(checker.install);
  const installErrorLabel = () => t().settings[installErrorCopyKey(checker.install.error)];
  const narrow = () => widthAtMost(540);

  return (
    <View testID="settings-about" class={`flex-col ${widthAtMost(720) ? "gap-3" : "gap-[14px]"}`}>
      <SettingsCard testID="settings-card-about">
        {/* One block: the pane is already titled About, so the card leads with the app itself. */}
        <View class="flex-row flex-wrap items-center gap-[14px]">
          <BrandMark size={44} />
          <View class="flex-col gap-[2px] min-w-0 shrink grow basis-0">
            <Text role="header" class="text-[14px] font-semibold text-ink leading-[1.25]">
              Deskfolk
            </Text>
            <Text class="text-[12px] leading-[1.35] text-ink-muted">{t().settings.aboutDescription}</Text>
            <Text testID="about-version" class="font-mono text-[12px] text-ink-muted">
              {t().settings.version(checker.version ?? "0.4.0")}
            </Text>
          </View>
          <If when={checker.available}>
            <View class={`flex-row items-center shrink-0 ${narrow() ? "w-full justify-end" : ""}`}>
              <View
                role="button"
                testID="about-check-update"
                accessibilityLabel={checker.status === "checking" ? t().settings.checkingUpdates : t().settings.checkUpdates}
                disabled={checker.status === "checking"}
                onPress={() => void checker.checkNow()}
                class="group flex-row items-center justify-center gap-[6px] px-3 py-[5px] bg-btn-secondary-bg hover:bg-btn-secondary-hover border border-line rounded-(--radius-md) disabled:opacity-[0.65]"
                style={{ boxShadow: shadow("xs") }}
              >
                <If when={checker.status === "checking"}>
                  <Icon name="spinner" class="animate-spin tint-ink-secondary" />
                </If>
                <Text class="text-[12px] font-medium text-ink-secondary group-hover:text-ink">
                  {checker.status === "checking" ? t().settings.checkingUpdates : t().settings.checkUpdates}
                </Text>
              </View>
            </View>
          </If>
        </View>

        <If when={checker.available}>
          <If when={checker.status === "error"}>
            <View testID="about-update-failed" class="mt-5 px-6 py-4 rounded-(--radius-md) bg-warn-bg border border-warn-line">
              <Text class="text-[12px] leading-[1.4] text-warn-text">{t().settings.updateFailed}</Text>
            </View>
          </If>
          <If when={checker.status !== "error" && checker.result?.updateAvailable && checker.result.latest}>
            <View testID="about-update-banner" class="flex-col gap-2 mt-[10px] px-3 py-[10px] rounded-(--radius-md) bg-accent-tint border border-accent-border">
              <Text class="text-[13px] font-semibold text-brand">{t().settings.updateAvailable(checker.result?.latest ?? "")}</Text>
              <If when={updateChanges().length > 0}>
                <Scroll class="max-h-[168px]">
                  <View testID="about-notes" class="flex-col pr-1">
                    <Text class="mb-1 text-[12px] font-semibold text-ink-secondary">{t().settings.updateChanges}</Text>
                    <Each of={updateChanges()} key={(group) => group.key}>
                      {(group, groupIndex) => (
                        <View class="flex-col">
                          <If when={group().heading}>
                            <Text class={`mb-[2px] text-[11px] font-semibold text-ink-secondary ${groupIndex() === 0 ? "" : "mt-2"}`}>{group().heading}</Text>
                          </If>
                          <View class="flex-col gap-[3px] pl-1">
                            <Each of={group().items} key={(item) => item.key}>
                              {(item) => (
                                <View class="flex-row gap-[6px]">
                                  <Text class="text-[12px] leading-[1.45] text-ink-secondary">•</Text>
                                  <Text class="shrink grow basis-0 text-[12px] leading-[1.45] text-ink-secondary">{item().text}</Text>
                                </View>
                              )}
                            </Each>
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </Scroll>
              </If>
              <If
                when={checker.installing}
                else={
                  <>
                    <If when={checker.install.phase === "failed"}>
                      <View testID="about-install-failed" class="flex-col gap-1">
                        <Text class="text-[12px] leading-[1.4] text-warn-text">{installErrorLabel()}</Text>
                        <If when={checker.install.detail}>
                          <Text class="font-mono text-[11px] leading-[1.4] text-ink-muted">{checker.install.detail}</Text>
                        </If>
                      </View>
                    </If>
                    <View class="flex-row flex-wrap items-center gap-4">
                      <If when={checker.installable}>
                        <Button testID="about-update-install" variant="primary" size="sm" onPress={() => void checker.startInstall()}>
                          {checker.install.phase === "failed" ? t().settings.updateInstallRetry : t().settings.updateInstall}
                        </Button>
                      </If>
                      <If when={checker.result?.downloadUrl}>
                        <Button testID="about-update-download" variant={checker.installable ? "secondary" : "primary"} size="sm" onPress={() => void checker.download()}>
                          {t().settings.updateDownload}
                        </Button>
                      </If>
                      <If when={checker.result?.releaseUrl}>
                        <Button testID="about-update-notes" size="sm" onPress={() => void checker.openNotes()}>
                          {t().settings.updateNotes}
                        </Button>
                      </If>
                      <If when={checker.ignoredVersion !== checker.result?.latest}>
                        <Button testID="about-update-ignore" variant="ghost" size="sm" onPress={() => checker.ignoreLatest()}>
                          {t().settings.updateIgnore}
                        </Button>
                      </If>
                    </View>
                    <If when={checker.installable && checker.install.phase !== "failed"}>
                      <Text class="mt-[2px] text-[12px] leading-[1.4] text-ink-muted">{t().settings.updateInstallHint}</Text>
                    </If>
                  </>
                }
              >
                <View testID="about-install" class="flex-col gap-[6px]">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="text-[12px] text-ink-secondary">{installLabel()}</Text>
                    <If when={checker.install.total}>
                      <Text class="font-mono text-[12px] text-ink-muted">
                        {`${formatBytes(checker.install.downloaded ?? 0)} / ${formatBytes(checker.install.total ?? 0)}`}
                      </Text>
                    </If>
                  </View>
                  <Progress
                    accessibilityLabel={installLabel()}
                    value={installPercentValue() ?? 0}
                    indeterminate={installPercentValue() === null}
                    trackClass="h-[5px] rounded-full bg-line-subtle overflow-hidden"
                    indicatorClass={installPercentValue() === null ? "h-full w-[40%] rounded-full bg-brand" : "h-full rounded-full bg-brand"}
                  />
                  <If when={checker.install.phase === "downloading"}>
                    <Button testID="about-install-cancel" variant="ghost" size="sm" class="self-start" onPress={() => void checker.cancelInstall()}>
                      {t().settings.updateInstallCancel}
                    </Button>
                  </If>
                </View>
              </If>
            </View>
          </If>
          <If when={checker.status === "ok" && !(checker.result?.updateAvailable && checker.result.latest)}>
            <View testID="about-up-to-date" class="mt-5 px-6 py-4 rounded-(--radius-md) bg-ok-bg border border-ok-line">
              <Text class="text-[12px] leading-[1.4] text-ok-text">{t().settings.upToDate}</Text>
            </View>
          </If>
        </If>
      </SettingsCard>
    </View>
  );
}
