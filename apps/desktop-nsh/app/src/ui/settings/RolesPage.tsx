/**
 * Roles (分工, ADR 0082) as a page of its own (ADR 0083; `settings/RolesPage.svelte`): the map of the
 * app's own calls with the picked one's model and prompts, opened from Tools or by a card about a
 * call's prompt — a tab on a wide window, a page in place of the list on a phone. It reads the
 * built-in prompts itself, as Settings does, again whenever one changes.
 *
 * Props: `host` ("pane" by default: a tab is closed by its tab; "page" has a head with Back, which
 * steps out of a call's page first); `onBack`. Test ids: `roles-page`, `roles-page-back`,
 * `roles-page-title`, and `RoutingTab`'s.
 */
import type { PromptSummary } from "@real-bot/protocol";
import { effect, signal, Text, untracked, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import { IconButton } from "../IconButton";
import { RoutingTab, type RoutingTabHandle } from "./RoutingTab";

export function RolesPage(props: { host?: "pane" | "page"; onBack?: () => void }) {
  const page = () => props.host === "page";
  const items = signal<PromptSummary[]>([]);
  const failed = signal(false);
  effect(() => {
    const api = runtime.client;
    void runtime.promptsRevision;
    const connected = runtime.connection === "connected";
    if (!api || !connected) return;
    void api.listPrompts().then(
      (rows) => {
        if (runtime.client !== api) return;
        items.set(rows);
        failed.set(false);
      },
      () => {
        if (runtime.client === api) failed.set(true);
      },
    );
  });

  const roles = signal<RoutingTabHandle | null>(null);
  const title = () => roles()?.sectionTitle() ?? copy().routing.tab;

  /** Back steps out of the prompt editor, then a call's page, then the page itself. */
  function back(): void {
    const handle = roles();
    if (handle?.backFromEditor() || handle?.backFromSection()) return;
    props.onBack?.();
  }

  // The phone's own Back takes the same steps: while a call's page or the editor is open, it steps
  // out of that rather than leaving the page, which is in the URL (the shell's list-page layer).
  effect(() => {
    if (!page() || !roles()?.deep()) return;
    return untracked(() => holdBack(() => back()));
  });

  return (
    <View testID="roles-page" class="flex-1 min-h-0 min-w-0 flex-col bg-pane">
      <If when={page()}>
        <View class="flex-row items-center justify-between h-[52px] pl-2 pr-3 py-[6px] border-b border-line shrink-0">
          <IconButton icon="chevron-left" size="lg" label={copy().common.back} testID="roles-page-back" onPress={back} />
          <Text role="header" testID="roles-page-title" class="flex-1 min-w-0 text-center text-[16px] font-semibold text-ink line-clamp-1">
            {title()}
          </Text>
          <View class="w-[38px] shrink-0" accessible={false} />
        </View>
      </If>
      <RoutingTab
        items={items()}
        loadFailed={failed()}
        openTab={() => runtime.openPromptSettings(null)}
        ownBack={!page()}
        onReady={(handle) => roles.set(handle)}
      />
    </View>
  );
}
