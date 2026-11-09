/**
 * What a + in the 「项目」 section offers (`sidebar/ProjectAddMenu.svelte`, ADR 0095, 0099): a new
 * session of each agent, in a folder you pick next on the section's +, right in the directory on a
 * directory's; on the section's, a terminal session to carry on; on a directory's, the directory
 * itself opened in the preview, and a terminal started in it. It hangs under the +, its right edge on
 * the +'s, or where a directory row was right-clicked (`point`); walks with the arrow keys (Enter
 * chooses), closes on Escape, Tab or a press elsewhere, and hands focus back to the +.
 *
 * `bind:open` is `open` with `onOpenChange`; `anchor` is the + view's ref (or null).
 */
import { effect, keymap, signal, Overlay, Text, View, type JSX, type ViewRef } from "nsh";
import type { ProjectAgent } from "@real-bot/protocol";
import { PROJECT_AGENTS } from "../../m/sidebar/project-groups";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { shadow } from "../styles";
import { AgentLogo } from "../settings/AgentLogo";

type Entry = { id: string; testID: string; label: string; icon?: IconName; agent?: ProjectAgent; run: () => void };

export function ProjectAddMenu(props: {
  /** The + it hangs from. */
  anchor: ViewRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What it is for, read out: the section's + or a directory's. */
  label: string;
  /** A folder is picked after: each "new" says so with an ellipsis. */
  picksFolder: boolean;
  onNew: (agent: ProjectAgent) => void;
  /** Carrying on a terminal session; a directory's + leaves it out. */
  onImport?: () => void;
  /** Opening the directory in the preview; only a directory's menu has one. */
  onOpenDir?: () => void;
  /** A terminal started in the directory; only a directory's menu has one. */
  onOpenTerminal?: () => void;
  /** Where a right-click opened it: it hangs there instead of under the +. */
  point?: { x: number; y: number } | null;
}) {
  return (
    <If when={props.open}>
      <Open {...props} />
    </If>
  );
}

function Open(props: Parameters<typeof ProjectAddMenu>[0]): JSX.Element {
  const t = () => copy();
  const active = signal(-1);

  const close = () => {
    props.onOpenChange(false);
    props.anchor?.focus();
  };
  const choose = (action: () => void) => () => {
    props.onOpenChange(false);
    action();
  };

  /** The entries in order, as the Svelte menu lays them out; separators go between groups. */
  const groups = (): Entry[][] => {
    const agents: Entry[] = PROJECT_AGENTS.map((agent) => ({
      id: `new-${agent}`,
      testID: `project-add-new-${agent}`,
      label: `${t().project.newWith(t().project.agentNames[agent])}${props.picksFolder ? "…" : ""}`,
      agent,
      run: () => props.onNew(agent),
    }));
    const out: Entry[][] = [agents];
    if (props.onImport) out.push([{ id: "import", testID: "project-add-import", label: t().project.importSession, icon: "file-down", run: props.onImport }]);
    const dir: Entry[] = [];
    if (props.onOpenDir) dir.push({ id: "dir", testID: "project-add-open-dir", label: t().project.openDir, icon: "folder", run: props.onOpenDir });
    if (props.onOpenTerminal) dir.push({ id: "terminal", testID: "project-add-open-terminal", label: t().project.openTerminal, icon: "terminal", run: props.onOpenTerminal });
    if (dir.length) out.push(dir);
    return out;
  };
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
        class="min-w-[200px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
        style={{ boxShadow: shadow("lg") }}
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
