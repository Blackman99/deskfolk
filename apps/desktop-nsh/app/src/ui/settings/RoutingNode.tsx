/**
 * One of the app's own calls on Settings › Roles (ADR 0082; `settings/RoutingNode.svelte`): what it
 * does, the model it runs on (ADR 0077) — an endpoint's, one of your local agents' (ADR 0079), or none
 * to run as before — and the prompts it runs with (ADR 0064), each opening in the prompt editor.
 *
 * Props: `role`; `view`; `providers`; `settings`; `defaultModel` (named on the option that follows
 * it); `patch(patch)`; `pickable`; `claudeStatus` / `agents` (asked once by the page; null offers
 * none); `claudeModels`; `promptsFailed`; `ui`; `botNames`; `onOpenPrompt(item)` (the Svelte's
 * `onopenprompt(item, event)`: the event only carried the focus back); `headless` (inside an engine
 * step's panel, which names the step itself). Test ids: `routing-detail-<role>`,
 * `routing-part-model`, `routing-part-prompts`.
 */
import { BOT_BUILTIN_MODEL_ROLES, type AgentsStatusResponse, type BuiltinModelRole, type ClaudeCodeStatus, type Locale, type PromptSummary, type Provider, type Settings, type SettingsPatch } from "@real-bot/protocol";
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { builtinModelsOf, builtinPatch } from "../../m/settings/builtin-models.ts";
import type { RoutingNodeView } from "../../m/settings/routing-map.ts";
import { shadow } from "../styles";
import { PromptRowList } from "./PromptRowList";
import { SideModelCard } from "./SideModelCard";
import { widthAtMost } from "../../platform/viewport";

export function RoutingNode(props: {
  role: BuiltinModelRole;
  view: RoutingNodeView;
  providers: readonly Provider[];
  settings: Settings;
  defaultModel: string | null;
  patch: (patch: SettingsPatch) => Promise<unknown | null>;
  pickable: boolean;
  claudeStatus: (() => Promise<ClaudeCodeStatus>) | null;
  agents: (() => Promise<AgentsStatusResponse>) | null;
  claudeModels?: Pick<MessengerApi, "claudeCodeModels"> | null;
  promptsFailed: boolean;
  ui: Locale;
  botNames: ReadonlyMap<string, string>;
  onOpenPrompt: (item: PromptSummary) => void;
  headless?: boolean;
}) {
  const t = () => copy();
  const c = () => t().routing;
  const phone = () => widthAtMost(720);
  const name = () => t().builtinModels.roles[props.role].name;
  const legacy = () => builtinModelsOf(props.settings).legacy;
  // An older daemon runs the organizer on an endpoint's model only.
  const offersAgents = () => !(legacy() && props.role === "organizer");
  const hint = "text-[12px] leading-[1.45] text-ink-muted";
  const framed = () => props.headless !== true;

  return (
    <View
      role="region"
      testID={`routing-detail-${props.role}`}
      accessibilityLabel={name()}
      class={`flex-col gap-[14px] min-w-0 ${framed() ? `bg-pane border border-line rounded-(--radius-md) ${phone() ? "p-3" : "p-[14px]"}` : ""}`}
      style={{ boxShadow: framed() && !phone() ? shadow("xs") : undefined }}
    >
      <If when={framed() && !phone()}>
        <View class="flex-col gap-[3px]">
          <Text role="header" class="text-[14px] font-semibold text-ink">{name()}</Text>
          <Text class={hint}>{t().builtinModels.roles[props.role].hint}</Text>
        </View>
      </If>
      <If when={framed() && phone()}>
        <Text class={hint}>{t().builtinModels.roles[props.role].hint}</Text>
      </If>

      <View testID="routing-part-model" class={`flex-col gap-2 min-w-0 ${framed() ? "pt-3 border-t border-line" : ""}`}>
        <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().model}</Text>
        <If
          when={props.view.choosable}
          else={<Text class={hint}>{c().older}</Text>}
        >
          <If when={props.pickable} else={<Text class={hint}>{c().noEndpoint}</Text>}>
            <SideModelCard
              framed={false}
              kind={props.role}
              providers={props.providers}
              chosen={builtinModelsOf(props.settings).chosen[props.role] ?? null}
              defaultModel={props.defaultModel}
              patch={props.patch}
              toPatch={(next) => builtinPatch(props.role, next, legacy())}
              title={name()}
              followDefault={BOT_BUILTIN_MODEL_ROLES.includes(props.role) ? () => t().builtinModels.followBot : t().builtinModels.followDefault}
              failed={t().builtinModels.failed}
              claude={offersAgents() && props.claudeStatus ? { status: props.claudeStatus, note: t().builtinModels.claudeNote } : null}
              agents={offersAgents() ? props.agents : null}
              claudeModels={props.claudeModels ?? null}
            />
          </If>
        </If>
      </View>

      <View testID="routing-part-prompts" class="flex-col gap-2 min-w-0 pt-3 border-t border-line">
        <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().prompts}</Text>
        <If
          when={props.view.prompts.length > 0}
          else={
            <If when={props.promptsFailed} else={<Text class={hint}>{c().noPrompts}</Text>}>
              <Text role="alert" class="text-[12px] text-danger-text">{c().promptsLoadFailed}</Text>
            </If>
          }
        >
          <PromptRowList items={props.view.prompts} ui={props.ui} botNames={props.botNames} onOpen={props.onOpenPrompt} stacked />
        </If>
      </View>
    </View>
  );
}
