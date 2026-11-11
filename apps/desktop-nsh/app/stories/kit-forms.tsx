/** The form kit on one screen: dropdowns, the phone sheet, empty state, toasts, the bars. */
import { signal, Text, View } from "nsh";
import { BuildUpdates } from "../src/m/build-version.svelte.ts";
import { showToast } from "../src/m/toast.svelte.ts";
import { BottomSheet, SheetItem, SheetSeparator } from "../src/ui/BottomSheet";
import { BuildUpdateNotice } from "../src/ui/BuildUpdateNotice";
import { Button } from "../src/ui/Button";
import { EmptyState } from "../src/ui/EmptyState";
import { ImageContextMenu } from "../src/ui/ImageContextMenu";
import { MobileNavigation, type Destination } from "../src/ui/MobileNavigation";
import { MultiSelect } from "../src/ui/MultiSelect";
import { Select } from "../src/ui/Select";
import { ToastHost } from "../src/ui/ToastHost";

const MODELS = [
  { value: "opus", label: "Opus", hint: "最强" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku", disabled: true },
];
const PEOPLE = ["Writer", "Editor", { value: "coder", label: "Coder", hint: "代码" }];

export default function KitForms() {
  const model = signal("");
  const people = signal<string[]>([]);
  const sheet = signal(false);
  const picked = signal("");
  const image = signal(false);
  const nav = signal<Destination>("sessions");
  const updates = new BuildUpdates("1", async () => ({ version: "2" }));
  updates.published = "2";
  const dismissed = signal(false);
  return (
    <View class="flex-1 gap-4 p-6 bg-bg">
      <View class="flex-row gap-3 items-start">
        <View class="w-[220px] gap-1">
          <Select testID="model" value={model()} options={MODELS} placeholder="选择模型" onChange={(v) => model.set(v)} />
          <Text testID="model-value" class="text-[12px] text-ink-muted">{`model=${model()}`}</Text>
        </View>
        <View class="w-[320px] gap-1">
          <MultiSelect
            testID="people"
            values={people()}
            options={PEOPLE}
            placeholder="选择成员"
            searchPlaceholder="搜索"
            emptyLabel="没有成员"
            noMatchLabel="没有匹配"
            removeLabel="移除"
            onChange={(v) => people.set(v)}
          />
          <Text testID="people-value" class="text-[12px] text-ink-muted">{`people=${people().join(",")}`}</Text>
        </View>
      </View>
      <View class="flex-row gap-2">
        <Button testID="open-sheet" onPress={() => sheet.set(true)}>打开面板</Button>
        <Button testID="show-toast" onPress={() => showToast("已复制", { action: { label: "撤销", run: () => picked.set("undone") } })}>提示</Button>
        <Button testID="open-image" onPress={() => image.set(true)}>图片菜单</Button>
        <Text testID="picked" class="text-[12px] text-ink-muted">{picked()}</Text>
      </View>
      <EmptyState size="inline" title="还没有对话" hint="从左边选一个 Bot 开始">
        <Button variant="primary" size="sm">新建</Button>
      </EmptyState>
      <MobileNavigation active={nav()} updateAvailable onNavigate={(d) => nav.set(d)} />
      <If when={!dismissed()}>
        <BuildUpdateNotice updates={updates} onReload={() => dismissed.set(true)} />
      </If>
      <If when={sheet()}>
        <BottomSheet title="选择动作" closeLabel="关闭" onClose={() => sheet.set(false)}>
          <SheetItem label="复制" icon="copy" onPress={() => { picked.set("copy"); sheet.set(false); }} />
          <SheetSeparator />
          <SheetItem label="删除" icon="trash" danger />
        </BottomSheet>
      </If>
      <If when={image()}>
        <ImageContextMenu src="data:image/png;base64,iVBORw0KGgo=" x={300} y={300} onClose={() => image.set(false)} />
      </If>
      <ToastHost />
    </View>
  );
}
