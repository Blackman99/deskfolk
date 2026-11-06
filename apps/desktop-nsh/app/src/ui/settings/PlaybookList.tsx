/**
 * The engines down the left of Roles on a wide window (`settings/PlaybookList.svelte`, ADR 0085),
 * kept as the conversations are kept down the left of the app: one row each — its name, the default
 * starred, when it last changed, and what it is in a line — the one shown tinted. The + makes a new
 * one from the one shown; a right-click on a row, or its ⋯, has the rest: make it the default, a new
 * one from it, rename, its history, remove. Naming one turns its row into a name field of the same
 * height, as renaming a project session does.
 *
 * Props: `playbooks`; `shown`; `onshow(id)`; `onmakedefault(id)`; `onhistory(id)`; `locale`.
 * Test ids: `playbook-list`, `playbook-list-add`, `playbook-row-<id>`, `playbook-more-<id>`,
 * `playbook-name` (the field, with `playbook-naming-new` / `playbook-naming-rename` around it).
 *
 * Not carried over: the keyboard's menu key (a context menu with no pointer) hangs the menu under
 * the row in the Svelte; NSH's `onContextMenu` always has a position, so it opens at that.
 */
import type { Locale, Playbook, PlaybookImpact } from "@real-bot/protocol";
import { computed, effect, keymap, platform, signal, Text, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import { formatListTime } from "../../m/sidebar/list-time.ts";
import { playbookName, type Playbooks } from "../../m/settings/playbooks.svelte.ts";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { DangerDialog } from "../overlays/DangerDialog";
import { PlaybookMenu } from "./PlaybookMenu";

type Naming = { kind: "new"; from: string } | { kind: "rename"; id: string };

export function PlaybookList(props: {
  playbooks: Playbooks;
  shown: string;
  onshow: (id: string) => void;
  onmakedefault: (id: string) => void;
  /** Its history beside the map, in the picked step's place. */
  onhistory: (id: string) => void;
  locale: Locale;
}) {
  const c = () => copy().playbooks;
  const nameOf = (playbook: Playbook | undefined) => playbookName(playbook, c().builtin);

  /** The line under a name: what a built-in is for, or what one of yours was made from. */
  function lineOf(playbook: Playbook): string {
    if (playbook.builtin) return c().builtinHint[playbook.id] ?? "";
    return c().basedOn(nameOf(props.playbooks.find(playbook.base_id)) || (c().builtin[playbook.base_id] ?? playbook.base_id));
  }

  const rowRefs = new Map<string, ViewRef>();
  const menu = signal<{ id: string; anchor: ViewRef | null; point: { x: number; y: number } | null } | null>(null);
  const menuFor = () => {
    const open = menu();
    return open ? props.playbooks.find(open.id) : undefined;
  };

  function openMenu(id: string, anchor: ViewRef | null, point: { x: number; y: number } | null): void {
    if (menu()?.id === id && !point) {
      menu.set(null);
      return;
    }
    menu.set({ id, anchor, point });
  }

  // A name being typed: a new engine made from `from`, or one of yours renamed.
  const naming = signal<Naming | null>(null);
  const draft = signal("");
  const failed = signal(false);
  /** Enter and the blur that follows it are one save, not two; Escape's blur saves nothing. */
  let busy = false;
  let done = false;
  let composing = false;

  function startNaming(next: Naming): void {
    naming.set(next);
    draft.set(next.kind === "rename" ? (props.playbooks.find(next.id)?.name ?? "") : "");
    failed.set(false);
    done = false;
  }

  function stopNaming(): void {
    done = true;
    naming.set(null);
  }

  async function commit(): Promise<void> {
    const now = naming();
    if (!now || busy || done) return;
    const next = draft().trim();
    // Blank, or the name it already has, leaves things as they were.
    if (!next || (now.kind === "rename" && next === (props.playbooks.find(now.id)?.name ?? ""))) {
      stopNaming();
      return;
    }
    busy = true;
    const made = now.kind === "new" ? await props.playbooks.create(now.from, next) : await props.playbooks.rename(now.id, next);
    busy = false;
    if (!made) {
      failed.set(true);
      return;
    }
    stopNaming();
    if (now.kind === "new") props.onshow(made.id);
  }

  // Escape gives the name up, before any Escape of the page around.
  effect(() => {
    if (!naming()) return;
    return keymap.bind("escape", () => stopNaming(), { when: "always" });
  });

  const removing = signal<Playbook | null>(null);

  async function remove(playbook: Playbook): Promise<void> {
    removing.set(null);
    await props.playbooks.remove(playbook.id);
    if (playbook.id === props.shown) props.onshow(props.playbooks.defaultId);
  }

  /** Making an engine with no jobs the default moves every conversation that follows it: said first (ADR 0103). */
  const moving = signal<{ id: string; impact: PlaybookImpact } | null>(null);

  async function makeDefault(id: string): Promise<void> {
    const impact = props.playbooks.find(id)?.resolved.jobs.on === false ? await props.playbooks.impactOf(id) : null;
    if (impact && impact.sessions > 0) moving.set({ id, impact });
    else props.onmakedefault(id);
  }

  const nowMs = computed(() => {
    void props.playbooks.list;
    return Date.now();
  });

  const nameField = (line: string, kind: "new" | "rename") => (
    <View testID={`playbook-naming-${kind}`} class={`gap-[2px] px-[10px] py-2 my-px border border-transparent rounded-(--radius-md) ${kind === "rename" && naming()?.kind === "rename" && (naming() as { id: string }).id === props.shown ? "bg-accent-tint" : ""}`}>
      <Input
        testID="playbook-name"
        autoFocus
        maxLength={40}
        placeholder={c().newName}
        accessibilityLabel={kind === "new" ? c().newName : c().nameLabel}
        value={draft()}
        ref={(node) => {
          if (kind === "rename") setTimeout(() => node.setSelection(0, draft().length), 0);
        }}
        onChange={(e) => {
          draft.set(e.value);
          failed.set(false);
        }}
        onCompositionChange={(e) => (composing = e.composing)}
        onSubmit={() => {
          if (!composing) void commit();
        }}
        onBlur={() => void commit()}
        class={`h-[21px] px-[6px] -ml-[7px] text-[14px] font-semibold text-ink bg-input-bg border rounded-(--radius-sm) ${failed() ? "border-danger" : "border-field-focus-border"}`}
      />
      <If when={failed()}>
        <Text role="alert" testID="playbook-name-error" class="text-[11px] text-danger-text">{props.playbooks.error === "conflict" ? c().conflict : c().failed}</Text>
      </If>
      <Text class="min-h-[17px] text-[12px] text-ink-muted line-clamp-1">{line}</Text>
    </View>
  );

  const row = (item: Playbook) => {
    const on = () => item.id === props.shown;
    return (
      <View class="group relative">
        <View
          role="tab"
          testID={`playbook-row-${item.id}`}
          accessibilityLabel={nameOf(item)}
          accessibilityState={{ selected: on() }}
          ref={(node: ViewRef) => rowRefs.set(item.id, node)}
          onPress={() => props.onshow(item.id)}
          onContextMenu={(e) => openMenu(item.id, rowRefs.get(item.id) ?? null, { x: e.pagePosition.x, y: e.pagePosition.y })}
          class={`px-[10px] py-2 my-px gap-[2px] border border-transparent rounded-(--radius-md) active:scale-[0.985] ${on() ? "bg-accent-tint" : "hover:bg-row-hover"}`}
        >
          <View class="flex-row items-baseline gap-[10px]">
            <View class="flex-1 min-w-0 flex-row items-baseline gap-1">
              <If when={item.id === props.playbooks.defaultId}>
                <View role="image" accessibilityLabel={c().isDefault}>
                  <Text class="shrink-0 text-[11px] text-brand">★</Text>
                </View>
              </If>
              <Text class="flex-1 min-w-0 text-[14px] font-semibold leading-[21px] text-ink line-clamp-1">{nameOf(item)}</Text>
            </View>
            <If when={platform.desktop}>
              <Text class={`text-[11px] text-ink-muted ${menu()?.id === item.id ? "opacity-0" : "group-hover:opacity-0"}`}>{formatListTime(item.updated_at, nowMs(), props.locale)}</Text>
            </If>
          </View>
          <Text class="min-h-[17px] text-[12px] leading-[17px] text-ink-muted line-clamp-1">{lineOf(item)}</Text>
        </View>
        <View
          role="button"
          testID={`playbook-more-${item.id}`}
          accessibilityLabel={copy().chat.moreActions}
          accessibilityState={{ expanded: menu()?.id === item.id }}
          ref={(node: ViewRef) => rowRefs.set(`more:${item.id}`, node)}
          onPress={() => openMenu(item.id, rowRefs.get(`more:${item.id}`) ?? null, null)}
          class={`absolute top-[9px] right-2 w-[26px] h-[26px] items-center justify-center rounded-[7px] ${platform.desktop ? `bg-pane border border-line ${menu()?.id === item.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}` : ""}`}
        >
          <Icon name="more" class="tint-ink-muted" />
        </View>
      </View>
    );
  };

  return (
    <>
      <If when={moving()}>
        {(target) => (
          <DangerDialog
            copy={{ title: c().defaultTitle, body: c().defaultBody(target().impact.sessions, target().impact.open_jobs), confirm: c().makeDefault, cancel: c().cancel }}
            onDismiss={() => moving.set(null)}
            onConfirm={() => {
              const id = target().id;
              moving.set(null);
              props.onmakedefault(id);
            }}
          />
        )}
      </If>
      <If when={removing()}>
        {(target) => (
          <DangerDialog
            copy={{ title: c().removeTitle(nameOf(target())), body: c().removeBody, confirm: c().remove, cancel: c().cancel }}
            onDismiss={() => removing.set(null)}
            onConfirm={() => void remove(target())}
          />
        )}
      </If>

      <View testID="playbook-list" class="min-w-0">
        <View class="flex-row items-center justify-between pl-[10px] pr-1 pt-[6px] pb-1">
          <Text class="text-[12px] font-semibold text-ink-muted">{c().title}</Text>
          <IconButton
            testID="playbook-list-add"
            icon="plus"
            size="xs"
            label={c().newFromShown(nameOf(props.playbooks.find(props.shown)))}
            disabled={props.playbooks.saving}
            onPress={() => startNaming({ kind: "new", from: props.shown })}
          />
        </View>
        <View role="tablist" accessibilityLabel={c().title}>
          {() => {
            const now = naming();
            return props.playbooks.items.map((item) =>
              now?.kind === "rename" && now.id === item.id ? nameField(lineOf(item), "rename") : row(item),
            );
          }}
          <If when={naming()?.kind === "new"}>
            {() => nameField(c().basedOn(nameOf(props.playbooks.find((naming() as { from: string } | null)?.from))), "new")}
          </If>
        </View>
      </View>

      <If when={menuFor()}>
        {(item) => (
          <PlaybookMenu
            playbook={item()}
            isDefault={item().id === props.playbooks.defaultId}
            anchor={menu()?.anchor ?? null}
            point={menu()?.point ?? null}
            label={nameOf(item())}
            onClose={() => menu.set(null)}
            onMakeDefault={(id) => void makeDefault(id)}
            onNew={(id) => startNaming({ kind: "new", from: id })}
            onRename={(id) => startNaming({ kind: "rename", id })}
            onHistory={props.onhistory}
            onRemove={(id) => removing.set(props.playbooks.find(id) ?? null)}
          />
        )}
      </If>
    </>
  );
}
