/** The identity kit on one screen: avatars, the brand mark, the avatar editor and the model picker, on sample data. */
import { Scroll, Text, View, signal } from "nsh";
import { generateBoringAvatar, type Bot, type SessionSummary } from "@real-bot/protocol";
import { AvatarEditor } from "../src/ui/AvatarEditor";
import { BrandMark } from "../src/ui/BrandMark";
import { FolkAvatar } from "../src/ui/FolkAvatar";
import { ModelPicker } from "../src/ui/ModelPicker";
import { ModelSourceMark } from "../src/ui/ModelSourceMark";
import { SessionAvatar } from "../src/ui/SessionAvatar";
import { groupModels, type PickerData } from "../src/m/model-picker";

const bot = (id: string, name: string, avatar: string | null): Bot => ({ id, name, avatar, archived_at: null }) as unknown as Bot;
const direct = (id: string, bots: string[]): SessionSummary =>
  ({
    id,
    kind: bots.length > 1 ? "group" : "direct",
    participants: [{ member: "user", left_at: null }, ...bots.map((member) => ({ member, left_at: null }))],
  }) as unknown as SessionSummary;

export const FOLK = generateBoringAvatar({ name: "Writer", variant: "folk" });
const BEAM = generateBoringAvatar({ name: "Editor", variant: "beam" });
const bots = new Map<string, Bot>([
  ["b1", bot("b1", "Writer", FOLK)],
  ["b2", bot("b2", "Editor", BEAM)],
  ["b3", bot("b3", "Coder", null)],
  ["b4", bot("b4", "Tester", null)],
]);

const rows = (ids: string[]) => ids.map((id) => ({ value: id, label: id }));
const opencode = [...Array(40)].map((_, i) => `${["alibaba", "nvidia", "xai"][i % 3]}/model-${i}`);
export const pickerData: PickerData = {
  specials: [{ value: "", label: "跟随默认" }],
  sources: [
    { key: "endpoint:cpa", label: "My CPA", mark: { kind: "custom", name: "Custom" }, groups: [{ key: "", label: null, rows: rows(["gemini-3.8", "grok-4.7"]) }] },
    { key: "agent:codex", label: "Codex", mark: { kind: "agent", runner: "codex", name: "Codex" }, groups: [{ key: "", label: null, rows: [{ value: "codex:gpt-5.6-terra", label: "GPT-5.6-Terra", detail: "gpt-5.6-terra" }] }] },
    { key: "agent:opencode", label: "OpenCode", mark: { kind: "agent", runner: "opencode", name: "OpenCode" }, groups: groupModels(rows(opencode)) },
    { key: "agent:custom:ca-1", label: "my-agent", mark: { kind: "agent", runner: "custom", name: "my-agent" }, groups: [], custom: (typed) => `custom:ca-1:${typed}` },
    { key: "agent:zcode", label: "ZCode", mark: null, groups: [], disabled: true, note: "没装" },
  ],
};

export default function KitIdentity() {
  const model = signal("");
  const avatar = signal<string>("");
  const name = signal("Pudding");
  return (
    <Scroll class="flex-1 bg-bg">
      <View class="gap-4 p-6">
        <View class="flex-row items-center gap-4">
          <View class="w-[44px] h-[44px]">
            <FolkAvatar avatar={FOLK} testID="folk-avatar" />
          </View>
          <View class="w-[44px] h-[44px]">
            <FolkAvatar avatar={FOLK} motion="waiting" />
          </View>
          <View class="w-[44px] h-[44px]">
            <FolkAvatar avatar={FOLK} motion="running" />
          </View>
          <View class="w-[44px] h-[44px]">
            <FolkAvatar avatar={FOLK} motion="held" />
          </View>
          <BrandMark size={32} testID="brand-mark" />
          <BrandMark size={32} variant="art" />
        </View>
        <View class="flex-row items-center gap-4">
          <SessionAvatar session={direct("s1", ["b1"])} bots={bots} testID="session-folk" />
          <SessionAvatar session={direct("s2", ["b2"])} bots={bots} testID="session-bot" />
          <SessionAvatar session={direct("s3", ["b3"])} bots={bots} />
          <SessionAvatar session={direct("s4", ["b1", "b2"])} bots={bots} />
          <SessionAvatar session={direct("s5", ["b1", "b2", "b3"])} bots={bots} />
          <SessionAvatar session={direct("s6", ["b1", "b2", "b3", "b4"])} bots={bots} />
          <SessionAvatar session={direct("s7", ["b1", "b2", "b3", "b4", "b1", "b2"])} bots={bots} />
          <SessionAvatar session={direct("s8", [])} bots={bots} />
        </View>
        <View class="flex-row items-center gap-3">
          <ModelSourceMark source={{ kind: "connector", id: "deepseek" as never, name: "DeepSeek" }} />
          <ModelSourceMark source={{ kind: "claude-agent", name: "Claude Agent" }} />
          <ModelSourceMark source={{ kind: "agent", runner: "grok", name: "Grok" }} />
          <ModelSourceMark source={{ kind: "custom", name: "Custom" }} />
        </View>
        <View class="w-[360px] gap-2">
          <ModelPicker value={model()} data={pickerData} ariaLabel="模型" onChange={(v) => model.set(v)} testID="model-picker" />
          <Text testID="picked" class="text-[12px] text-ink-muted">{`picked: ${model()}`}</Text>
        </View>
        <View class="w-[420px]">
          <AvatarEditor name={name()} avatar={avatar()} onAvatarChange={(a) => avatar.set(a)} />
          <Text testID="editor-avatar" class="text-[12px] text-ink-muted">{`${avatar().length}:${[...avatar()].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) | 0, 7)}`}</Text>
        </View>
      </View>
    </Scroll>
  );
}
