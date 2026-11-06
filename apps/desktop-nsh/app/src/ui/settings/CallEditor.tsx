/**
 * One of the app's own calls, changed where it is shown — a step's panel on the flow (ADR 0083;
 * `settings/CallEditor.svelte`) — instead of on Roles: its model and its prompts as Roles has them,
 * a prompt opening in the same editor (`PromptEditorPage`, already a dialog over the whole window,
 * so the Svelte's move to `document.body` has nothing to do here).
 *
 * Props: `role`. Reads the built-in prompts itself, again whenever one changes. Test ids:
 * `call-editor-<role>`, and `RoutingNode`'s.
 *
 * Not carried over: focus is not handed to the editor's text or back to the row (NSH has no element
 * focus to hand around).
 */
import type { BuiltinModelRole, Locale, PromptSummary } from "@real-bot/protocol";
import { computed, effect, signal, untracked, View } from "nsh";
import { runtime } from "../../runtime";
import { holdBack } from "../../m/chat/message-text-pages.ts";
import { firstLocale, type PromptView } from "../../m/settings/prompts-view.ts";
import { askOnce, routingNodeView } from "../../m/settings/routing-map.ts";
import { PromptEditorPage } from "./PromptEditorPage";
import { RoutingNode } from "./RoutingNode";

export function CallEditor(props: { role: BuiltinModelRole }) {
  const snapshot = () => runtime.snapshot;
  const ui = (): Locale => (snapshot().settings.locale === "en" ? "en" : "zh");
  const botNames = () => new Map(snapshot().bots.map((bot) => [bot.id, bot.name] as const));

  // The built-in prompts, read as Roles reads them, again whenever one changes.
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

  /** Set up on a local agent with no endpoint (ADR 0078, ADR 0079): the calls are on its models. */
  const onAgent = () => Object.values(snapshot().settings.builtin_models ?? {}).some((chosen) => chosen !== null && typeof chosen === "object" && "runner" in chosen);
  const pickable = () => snapshot().providers.length > 0 || onAgent();
  /** Asked once for each client, however often it is read. */
  const claudeStatus = computed(() => {
    const api = runtime.client;
    return api ? askOnce(() => api.claudeCode()) : null;
  });
  const agents = computed(() => {
    const api = runtime.client;
    return api ? askOnce(() => api.agents()) : null;
  });

  // The prompt editor, as Roles opens it.
  const open = signal<{ id: string; locale: Locale } | null>(null);
  const view = signal<PromptView>("text");
  let flushEditor: () => Promise<void> = async () => {};
  const openItem = () => {
    const at = open();
    return at ? items().find((item) => item.id === at.id) : undefined;
  };

  function openEditor(item: PromptSummary): void {
    view.set("text");
    open.set({ id: item.id, locale: firstLocale(item, ui()) });
  }

  /** Back on a phone, ✕ or Escape: what you typed is saved first. */
  async function closeEditor(): Promise<void> {
    await flushEditor();
    open.set(null);
  }

  // On a phone Back closes the editor before the panel it was opened from.
  effect(() => {
    if (!open()) return;
    return holdBack(() => void closeEditor());
  });

  function openMessage(sessionId: string, messageId: string): void {
    void flushEditor();
    open.set(null);
    untracked(() => void runtime.selectSession(sessionId, { messageId }));
  }

  return (
    <View testID={`call-editor-${props.role}`}>
      <RoutingNode
        role={props.role}
        view={routingNodeView(props.role, snapshot().settings, items())}
        providers={snapshot().providers}
        settings={snapshot().settings}
        defaultModel={snapshot().settings.endpoint_default_model}
        patch={(patch) => runtime.patchSettings(patch)}
        pickable={pickable()}
        claudeStatus={claudeStatus()}
        agents={agents()}
        promptsFailed={failed()}
        ui={ui()}
        botNames={botNames()}
        onOpenPrompt={openEditor}
      />
      <If when={open() && openItem()}>
        {(item) => (
          <PromptEditorPage
            item={item()}
            open={open()!}
            view={view()}
            onViewChange={(next) => view.set(next)}
            onClose={() => void closeEditor()}
            onLocale={(locale) => open.set({ id: open()!.id, locale })}
            onOpenMessage={openMessage}
            onReady={(api) => {
              flushEditor = api.flush;
            }}
          />
        )}
      </If>
    </View>
  );
}
