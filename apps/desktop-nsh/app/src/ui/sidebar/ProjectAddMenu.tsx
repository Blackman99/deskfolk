/**
 * What a + in the 「项目」 section offers (`sidebar/ProjectAddMenu.svelte`, ADR 0095, 0099): a new
 * session of each agent, in a folder you pick next on the section's +, right in the directory on a
 * directory's; on the section's, a terminal session to carry on; on a directory's, the directory
 * itself opened in the preview, and a terminal started in it. It hangs under the +, its right edge on
 * the +'s, or where a directory row was right-clicked (`point`); walks with the arrow keys (Enter
 * chooses), closes on Escape, Tab or a press elsewhere, and hands focus back to the +.
 *
 * On a phone it is a `BottomSheet` instead, as a row's long-press menu and the create button's are:
 * rows sized for a thumb, from the bottom of the screen, not a desktop's small menu hanging off the
 * +. The sheet is named after `title` (the directory); its ✕, backdrop and the phone's Back close it.
 * A `point` means nothing there: the sheet stands at the bottom wherever it was asked.
 *
 * `bind:open` is `open` with `onOpenChange`; `anchor` is the + view's ref (or null).
 */
import { effect, keymap, signal, Overlay, Text, View, type JSX, type ViewRef } from "nsh";
import type { GitPaneView, ProjectAgent } from "@real-bot/protocol";
import { PROJECT_AGENTS } from "../../m/sidebar/project-groups";
import { copy } from "../../runtime";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { MENU_SURFACE, shadow } from "../styles";
import { AgentLogo } from "../settings/AgentLogo";

type Entry = { id: string; testID: string; label: string; icon?: IconName; agent?: ProjectAgent; run: () => void };

type ProjectAddMenuProps = {
  /** The + it hangs from. */
  anchor: ViewRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What it is for, read out: the section's + or a directory's. */
  label: string;
  /** The phone's sheet's heading (a directory's name); `label` when left out. */
  title?: string;
  /** A folder is picked after: each "new" says so with an ellipsis. */
  picksFolder: boolean;
  onNew: (agent: ProjectAgent) => void;
  /** Carrying on a terminal session; a directory's + leaves it out. */
  onImport?: () => void;
  /** Opening the directory in the preview; only a directory's menu has one. */
  onOpenDir?: () => void;
  /** A terminal started in the directory; only a directory's menu has one. */
  onOpenTerminal?: () => void;
  /** Open the directory's Git & GitHub pane onto a view or the repo/worktree switcher (ADR 0118). */
  onOpenGit?: (target: GitPaneView | "picker") => void;
  /** Where a right-click opened it: it hangs there instead of under the +. */
  point?: { x: number; y: number } | null;
};

export function ProjectAddMenu(props: ProjectAddMenuProps) {
  return (
    <If when={props.open}>
      <If when={narrowWindow()} else={<Dropdown {...props} />}>
        <InSheet {...props} />
      </If>
    </If>
  );
}

/** The entries in order, as the Svelte menu lays them out; separators go between groups. */
function groupsOf(props: ProjectAddMenuProps): Entry[][] {
  const t = copy();
  const agents: Entry[] = PROJECT_AGENTS.map((agent) => ({
    id: `new-${agent}`,
    testID: `project-add-new-${agent}`,
    label: `${t.project.newWith(t.project.agentNames[agent])}${props.picksFolder ? "…" : ""}`,
    agent,
    run: () => props.onNew(agent),
  }));
  const out: Entry[][] = [agents];
  if (props.onImport) out.push([{ id: "import", testID: "project-add-import", label: t.project.importSession, icon: "file-down", run: props.onImport }]);
  const dir: Entry[] = [];
  if (props.onOpenDir) dir.push({ id: "dir", testID: "project-add-open-dir", label: t.project.openDir, icon: "folder", run: props.onOpenDir });
  if (props.onOpenTerminal) dir.push({ id: "terminal", testID: "project-add-open-terminal", label: t.project.openTerminal, icon: "terminal", run: props.onOpenTerminal });
  if (dir.length) out.push(dir);
  if (props.onOpenGit) {
    out.push([
      { id: "git-changes", testID: "project-add-git-changes", label: t.git.openChanges, icon: "git-branch", run: () => props.onOpenGit!("changes") },
      { id: "git-graph", testID: "project-add-git-graph", label: t.git.openGraph, icon: "history", run: () => props.onOpenGit!("graph") },
      { id: "git-worktrees", testID: "project-add-git-worktrees", label: t.git.openWorktrees, icon: "layers", run: () => props.onOpenGit!("picker") },
      { id: "git-github", testID: "project-add-git-github", label: t.git.openGitHub, icon: "globe", run: () => props.onOpenGit!("github") },
    ]);
  }
  return out;
}

/** The phone's: a sheet from the bottom, rows sized for a thumb. Escape and Back are the sheet's. */
function InSheet(props: ProjectAddMenuProps): JSX.Element {
  const t = () => copy();
  const close = () => props.onOpenChange(false);
  // As a row's long-press sheet does: the choice runs, then the sheet goes.
  const choose = (action: () => void) => () => {
    action();
    close();
  };
  const row = (entry: Entry): JSX.Element => (
    <SheetItem
      role="menuitem"
      testID={entry.testID}
      label={entry.label}
      icon={entry.agent ? undefined : (entry.icon ?? "plus")}
      leading={entry.agent ? <AgentLogo runner={entry.agent} size={20} /> : undefined}
      onPress={choose(entry.run)}
    />
  );
  return (
    <BottomSheet title={props.title ?? props.label} closeLabel={t().common.close} onClose={close}>
      <View role="menu" testID="project-add-menu" accessibilityLabel={props.label}>
        {() =>
          groupsOf(props).flatMap((group, i) => [
            ...(i > 0 ? [<SheetSeparator />] : []),
            ...group.map(row),
          ])
        }
      </View>
    </BottomSheet>
  );
}

/** A wider window's: a menu under the + (or at the pointer), walked with the keys. */
function Dropdown(props: ProjectAddMenuProps): JSX.Element {
  const active = signal(-1);

  const close = () => {
    props.onOpenChange(false);
    props.anchor?.focus();
  };
  const choose = (action: () => void) => () => {
    props.onOpenChange(false);
    action();
  };

  const groups = () => groupsOf(props);
  const flat = () => groups().flat();
  const step = (by: number) => {
    const n = flat().length;
    if (n === 0) return;
    active.set(active() < 0 ? (by > 0 ? 0 : n - 1) : (active() + by + n) % n);
  };

  effect(() => {
    const off = [
      keymap.bind("escape", close, { when: "always" }),
      keymap.bind("tab", close, { when: "always" }),
      keymap.bind("down", () => step(1), { when: "always" }),
      keymap.bind("up", () => step(-1), { when: "always" }),
      keymap.bind("home", () => active.set(0), { when: "always" }),
      keymap.bind("end", () => active.set(flat().length - 1), { when: "always" }),
      keymap.bind("enter", () => {
        const entry = flat()[active()];
        if (entry) choose(entry.run)();
      }, { when: "always" }),
    ];
    return () => off.forEach((fn) => fn());
  });

  const row = (entry: Entry): JSX.Element => (
    <View
      role="menuitem"
      testID={entry.testID}
      accessibilityLabel={entry.label}
      onPress={choose(entry.run)}
      onMouseEnter={() => active.set(flat().indexOf(entry))}
      class={`cursor-pointer select-none flex-row items-center gap-[10px] min-h-[36px] px-[10px] rounded-(--radius-sm) hover:bg-row-hover ${flat()[active()]?.id === entry.id ? "bg-row-hover" : ""}`}
    >
      <If when={entry.agent} else={<Icon name={entry.icon ?? "plus"} size={16} class="tint-ink-muted" />}>
        {(agent) => <AgentLogo runner={agent()} size={18} />}
      </If>
      <Text class="text-[13px] font-medium text-ink">{entry.label}</Text>
    </View>
  );

  return (
    <Overlay
      anchor={props.point ?? props.anchor}
      placement="bottom"
      align={props.point ? "start" : "end"}
      offset={props.point ? 0 : 4}
      margin={8}
      onPressOutside={() => props.onOpenChange(false)}
      onCancel={close}
    >
      <View
        role="menu"
        testID="project-add-menu"
        accessibilityLabel={props.label}
        class={`min-w-[200px] ${MENU_SURFACE}`}
        style={{ boxShadow: shadow("menu") }}
      >
        {() =>
          groups().flatMap((group, i) => [
            ...(i > 0 ? [<View class="h-[1px] mx-[6px] my-1 bg-line" />] : []),
            ...group.map(row),
          ])
        }
      </View>
    </Overlay>
  );
}
