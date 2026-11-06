/** The building blocks of the settings pages: cards, rows, help tips, section tabs and list, the workspace fields, the independent-runtime confirmation. */
import { Scroll, signal, Text, View } from "nsh";
import { Switch } from "../src/ui/Switch";
import { Icon } from "../src/ui/Icon";
import { copy, runtime } from "../src/runtime";
import { AutosaveState } from "../src/ui/settings/AutosaveState";
import { HelpTip } from "../src/ui/settings/HelpTip";
import { IndependentConfirm } from "../src/ui/settings/IndependentConfirm";
import { SettingsCard } from "../src/ui/settings/SettingsCard";
import { SettingsCardHeader } from "../src/ui/settings/SettingsCardHeader";
import { SettingsRow } from "../src/ui/settings/SettingsRow";
import { SettingsSectionList } from "../src/ui/settings/SettingsSectionList";
import { SettingsSectionTabs } from "../src/ui/settings/SettingsSectionTabs";
import { SettingsSubpageButton } from "../src/ui/settings/SettingsSubpageButton";
import { WorkspaceField } from "../src/ui/settings/WorkspaceField";
import { WorkspacePicker } from "../src/ui/settings/WorkspacePicker";
import { gatedIndependentStatus, type IndependentStatus } from "../src/m/settings/independent-runtime.ts";

const SECTIONS = ["providers", "ladder", "builtin"] as const;
type Section = (typeof SECTIONS)[number];
const NAMES: Record<Section, string> = { providers: "模型服务", ladder: "模型阶梯", builtin: "内置模型" };
const SUMMARIES: Record<Section, string> = { providers: "3 个服务，2 个可用", ladder: "按任务难度换模型", builtin: "随应用提供的模型" };

const PAGES: Record<string, { path: string; parent: string | null; truncated: boolean; items: { name: string; path: string; kind: "dir" | "file" }[] }> = {
  "": { path: "/Users/a", parent: "/Users", truncated: false, items: [{ name: "locked", path: "/Users/a/locked", kind: "dir" }, { name: "work", path: "/Users/a/work", kind: "dir" }, { name: "notes.txt", path: "/Users/a/notes.txt", kind: "file" }] },
  "/Users/a/work": { path: "/Users/a/work", parent: "/Users/a", truncated: false, items: [] },
};
const hostApi = {
  hostTree: async (path: string) => {
    const page = PAGES[path];
    if (!page) throw Object.assign(new Error("denied"), { code: "host_permission" });
    return page;
  },
};

export default function SettingsBase() {
  const dark = signal(false);
  const active = signal<Section>("providers");
  const picked = signal("");
  const saving = signal(false);
  const failed = signal(false);
  const saved = signal(false);
  const workspace = signal("");
  const remoteWorkspace = signal("");
  const wsId = signal("");
  const confirm = signal<"enable" | "disable" | null>(null);
  const status = signal<IndependentStatus>(gatedIndependentStatus("gated"));
  const log = signal("");
  const act = (name: string, next?: () => void) => async () => {
    log.set(name);
    next?.();
  };
  const t = () => copy();
  const icon = (of: Section, size: number, on = false) => (
    <Icon name={of === "providers" ? "plug" : of === "ladder" ? "layers" : "sparkles"} size={size as 16} class={on ? "tint-brand" : "tint-ink-muted"} />
  );
  return (
    <Scroll class="flex-1 bg-bg">
    <View class="flex-col gap-4 p-6">
      <SettingsCard testID="card">
        <SettingsCardHeader
          title="偏好设置"
          subtitle="外观、语言与工作区"
          after={<HelpTip testID="tip-prefs" text="这里的选项改动后立即保存，无需确认。" label="关于偏好设置" />}
          end={<AutosaveState saving={saving()} failed={failed()} saved={saved()} />}
        />
        <SettingsRow title="深色模式" titleId="dark-label" desc="跟随系统外观，或固定为深色。" titleAfter={<Text class="text-[11px] text-ink-muted">实验</Text>}>
          <Switch checked={dark()} label="深色模式" testID="dark-switch" onChange={(v) => dark.set(v)} />
        </SettingsRow>
        <SettingsRow title="工作区" titleId="workspace-label" desc="新对话默认使用的文件夹。" notes={<Text class="text-[11px] text-ink-muted">只影响新对话</Text>} last>
          <Text testID="dark-state" class="text-[12px] text-ink-muted">{dark() ? "dark:on" : "dark:off"}</Text>
        </SettingsRow>
      </SettingsCard>
      <View class="flex-row gap-2">
        <View role="button" testID="save-go" onPress={() => { saving.set(true); }} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px]">saving</Text></View>
        <View role="button" testID="save-done" onPress={() => { saving.set(false); saved.set(true); }} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px]">saved</Text></View>
        <View role="button" testID="save-fail" onPress={() => { saving.set(false); failed.set(true); }} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px]">failed</Text></View>
      </View>
      <SettingsCard>
        <SettingsSectionTabs
          id="models"
          sections={SECTIONS}
          active={active()}
          label={(of) => NAMES[of]}
          count={(of) => (of === "providers" ? 3 : of === "ladder" ? 1 : 0)}
          warn={(of) => of === "ladder"}
          icon={icon}
          ariaLabel="模型"
          onPick={(of) => active.set(of)}
        />
        <Text testID="active-section" class="text-[12px] text-ink-muted">{`active:${active()}`}</Text>
        <SettingsSectionList sections={SECTIONS} label={(of) => NAMES[of]} summary={(of) => SUMMARIES[of]} icon={(of, size) => icon(of, size)} ariaLabel="模型" onPick={(of) => picked.set(of)} />
        <Text testID="picked-section" class="text-[12px] text-ink-muted">{`picked:${picked()}`}</Text>
        <SettingsSubpageButton kind="back" label="返回模型服务" onPress={() => log.set("back")} />
        <SettingsSubpageButton kind="close" title="关闭" onPress={() => log.set("close")} />
      </SettingsCard>
      <SettingsCard>
        <WorkspacePicker
          id="workspace"
          path={workspace()}
          chooseLabel="选择文件夹"
          changeLabel="更换"
          emptyLabel="尚未设置"
          unavailableLabel="无法打开文件夹选择器"
          dialogTitle="选择工作区"
          onChange={(p) => workspace.set(p)}
          shown={(p) => p}
        />
        <WorkspacePicker
          id="remote-workspace"
          path={remoteWorkspace()}
          chooseLabel="选择文件夹"
          changeLabel="更换"
          emptyLabel="尚未设置"
          unavailableLabel="无法读取这个文件夹"
          dialogTitle="选择主机上的文件夹"
          remote
          api={hostApi as never}
          browseHint="浏览主机上的文件夹"
          permissionHint="请在 Mac 上授权访问"
          truncatedHint="只显示前面的一部分"
          upLabel="上一级"
          useLabel="使用这个文件夹"
          cancelLabel="取消"
          onChange={(p) => remoteWorkspace.set(p)}
        />
        <WorkspaceField id="ws-id" value={wsId()} invalid={false} onInput={(v) => wsId.set(v)} />
        <Text testID="workspace-value" class="text-[12px] text-ink-muted">{`workspace:${workspace()}|${remoteWorkspace()}`}</Text>
      </SettingsCard>
      <View class="flex-row gap-2">
        <View role="button" testID="ask-enable" onPress={() => { runtime.settingsOpen = true; confirm.set("enable"); }} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px]">enable</Text></View>
        <View role="button" testID="ask-drain" onPress={() => { runtime.settingsOpen = true; status.set({ ...status(), drain: { phase: "draining", remaining: [], forced: false }, error: "busy" }); confirm.set("disable"); }} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px]">drain</Text></View>
        <Text testID="log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
      </View>
      <IndependentConfirm
        independent={status()}
        independentConfirm={confirm()}
        independentReason={(s) => `原因：${s.error}`}
        confirmIndependent={act("confirm", () => confirm.set(null))}
        waitIndependent={act("wait")}
        forceIndependent={act("force", () => { status.set(gatedIndependentStatus("gated")); confirm.set(null); })}
        cancelIndependent={act("cancel", () => { status.set(gatedIndependentStatus("gated")); confirm.set(null); })}
      />
    </View>
    </Scroll>
  );
}
