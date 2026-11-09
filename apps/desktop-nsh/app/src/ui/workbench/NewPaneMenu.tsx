/**
 * What a pane's new-tab menu lists, under its search field: a new terminal, the workspace, the
 * calendar and the ledger, then the running terminals no tab shows yet, narrowed by the query
 * (`NewPaneMenu.svelte`). The menu itself (its field, scrolling and placement) is `WorkbenchLeaf`'s;
 * its rows are drawn here, with the `wb-menu-*` look of the Svelte stylesheet.
 *
 * `onPick` is called after a row's action so the host menu closes (the Svelte menu closed on any
 * click of a `menuitem`).
 */
import { Text, View } from "nsh";
import { runtime, copy } from "../../runtime";
import { spendCopyFor } from "../../m/spend/spend-copy.ts";
import type { ShellWorkbench } from "../../m/workbench/shell-workbench.svelte.ts";
import { Icon, type IconName } from "../Icon";
import { tip } from "../tip";

/** The part of the shell's workbench state this menu reads and calls. */
export type NewPaneHost = Pick<ShellWorkbench, "untabbedTerminals" | "terminalName" | "openNewTerminal" | "openInPane">;

export function NewPaneRow(props: {
  testID: string;
  icon: IconName;
  quiet?: boolean;
  name: string;
  meta?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="menuitem"
      testID={props.testID}
      accessibilityLabel={props.name}
      disabled={props.disabled}
      tooltip={props.meta ? tip(props.meta) : undefined}
      onPress={props.onPress}
      class="cursor-pointer select-none disabled:cursor-default flex-row items-center gap-2 w-full min-h-[32px] px-2 py-[5px] rounded-(--radius-md) hover:bg-row-hover focus-visible:bg-row-hover disabled:opacity-[0.6]"
    >
      <View accessible={false} class={`w-[22px] h-[22px] shrink-0 items-center justify-center rounded-(--radius-sm) ${props.quiet ? "bg-bg" : "bg-accent-tint"}`}>
        <Icon name={props.icon} size={16} class={props.quiet ? "tint-ink-muted" : "tint-brand"} />
      </View>
      <View class="flex-1 min-w-0">
        <Text class={`text-[13px] line-clamp-1 ${props.disabled ? "text-ink-muted" : "text-ink"}`}>{props.name}</Text>
        <If when={props.meta}>{(meta) => <Text class="text-[11px] text-ink-muted line-clamp-1">{meta()}</Text>}</If>
      </View>
    </View>
  );
}

export function NewPaneMenu(props: {
  workbench: NewPaneHost;
  leafId: string;
  query: string;
  /** A row was pressed: the menu around it can close. */
  onPick?: () => void;
}) {
  const t = () => copy();
  const needle = () => props.query.trim().toLowerCase();
  const listed = () => {
    const rows = props.workbench.untabbedTerminals;
    if (!needle()) return rows;
    return rows.filter((row) => `${props.workbench.terminalName(row)} ${row.cwd}`.toLowerCase().includes(needle()));
  };
  const picked = (run: () => void) => () => {
    run();
    props.onPick?.();
  };
  const open = (content: Parameters<NewPaneHost["openInPane"]>[1]) => picked(() => props.workbench.openInPane(props.leafId, content));

  return (
    <View testID="wb-new-pane-menu">
      <NewPaneRow testID="wb-new-pane-terminal" icon="terminal" name={t().terminal.newTab} onPress={picked(() => void props.workbench.openNewTerminal(props.leafId))} />
      <NewPaneRow
        testID="wb-new-pane-workspace"
        icon="layers"
        quiet
        name={t().sidebar.workspace}
        disabled={!runtime.snapshot.settings.workspace_path}
        onPress={open({ kind: "workspace", selected: null })}
      />
      <NewPaneRow testID="wb-new-pane-routines" icon="calendar" quiet name={t().routines.title} onPress={open({ kind: "routines" })} />
      <NewPaneRow
        testID="wb-new-pane-spend"
        icon="dollar"
        quiet
        name={spendCopyFor(runtime.snapshot.settings.locale === "en" ? "en" : "zh").title}
        onPress={open({ kind: "spend" })}
      />
      <NewPaneRow testID="wb-new-pane-usage" icon="gauge" quiet name={t().usage.title} onPress={open({ kind: "usage" })} />
      <NewPaneRow testID="wb-new-pane-roles" icon="nodes" quiet name={t().routing.tab} onPress={open({ kind: "roles" })} />
      <Text role="none" class="px-2 pt-2 pb-[2px] mt-1 border-t border-line text-[11px] font-semibold text-ink-muted tracking-wide">
        {t().pane.runningTerminals}
      </Text>
      <If
        when={listed().length > 0}
        else={<Text class="px-2 pt-[10px] pb-2 text-[12px] text-ink-muted">{needle() ? t().sidebar.emptySearch : t().pane.noRunningTerminals}</Text>}
      >
        {() =>
          listed().map((row) => (
            <NewPaneRow
              testID={`wb-menu-terminal-${row.id}`}
              icon="terminal"
              quiet
              name={props.workbench.terminalName(row)}
              meta={row.cwd}
              onPress={open({ kind: "terminal", terminalId: row.id })}
            />
          ))
        }
      </If>
    </View>
  );
}
