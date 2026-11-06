/**
 * A request waiting on your approval in the transcript (`TranscriptApproval.svelte`), with the key it
 * may need and its buttons. Waiting, the head says it waits on you, in the warn tint; answered, the
 * card settles into its outcome. A Bot's change to a built-in prompt or to your interface carries
 * its own card (`PromptEditCard`, `InterfaceEditCard`).
 */
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { modeAllowing, type ResolveApprovalAction } from "@real-bot/protocol";
import {
  approvalForMessage,
  approvalNeedsSecret,
  approvalSecretRequired,
  isHttpMcpApproval,
  isInterfaceEdit,
  isPromptEdit,
} from "../../m/chat/approval-card.ts";
import type { TranscriptGroup } from "../../m/chat/chat-view.ts";
import type { TranscriptStage } from "../../m/chat/transcript-stage.ts";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { InterfaceEditCard } from "./InterfaceEditCard";
import { PromptEditCard } from "./PromptEditCard";

type ApprovalCard = {
  id: string;
  kind_key: string | null;
  target: string | null;
  requires_api_key: boolean;
};

export function TranscriptApproval(props: { group: TranscriptGroup; stage: TranscriptStage }) {
  const t = () => copy();
  const single = () => props.group.items[0];
  const stage = () => props.stage;
  const message = () => {
    const item = single();
    return item && item.type === "message" ? item.message : null;
  };

  async function resolveApprovalCard(card: ApprovalCard, action: ResolveApprovalAction): Promise<void> {
    const key = stage().approvalKeys[card.id] ?? "";
    if (action !== "deny" && approvalSecretRequired(card) && key.trim().length === 0) {
      stage().approvalKeyErrors = { ...stage().approvalKeyErrors, [card.id]: true };
      return;
    }
    const error = await runtime.resolveApproval(card.id, action, key, stage().selected?.id);
    if (error && error.status === 422 && approvalNeedsSecret(card)) {
      stage().approvalKeyErrors = { ...stage().approvalKeyErrors, [card.id]: true };
      return;
    }
    if (!error) {
      const nextKeys = { ...stage().approvalKeys };
      delete nextKeys[card.id];
      stage().approvalKeys = nextKeys;
      const nextErrors = { ...stage().approvalKeyErrors };
      delete nextErrors[card.id];
      stage().approvalKeyErrors = nextErrors;
    }
  }

  function statusCopy(status: "allowed_once" | "denied" | "voided" | "pending"): string {
    if (status === "allowed_once") return t().stream.allowed;
    if (status === "denied") return t().stream.denied;
    if (status === "voided") return t().stream.voided;
    return t().stream.approval;
  }

  return (
    <If when={message()}>
            {(msg: () => NonNullable<ReturnType<typeof message>>) => {
              const card = () => approvalForMessage(stage().snapshot.approvals, msg());
              const pending = () => card()?.status === "pending";
              const hit = () => stage().highlightedId === msg().id;
              return (
                <View testID={`approval-row-${msg().id}`} class={`w-full self-stretch ${hit() ? "bg-accent-tint border border-accent-border rounded-(--radius-md)" : ""}`}>
                  <View
                    testID="approval-card"
                    selectable
                    class={`self-stretch overflow-hidden bg-pane border rounded-(--radius-lg) ${pending() ? "border-warn-line" : "border-line"}`}
                    style={{ boxShadow: shadow(pending() ? "sm" : "xs") }}
                  >
                    <View
                      testID="approval-head"
                      class={`flex-row items-center gap-[6px] px-[16px] py-[9px] border-b ${pending() ? "bg-warn-bg border-warn-line" : "bg-line-subtle border-line-subtle"}`}
                    >
                      <If when={pending()}>
                        <Icon name="shield-check" size={12} class="tint-warn-text" />
                      </If>
                      <Text class={`text-[12px] font-semibold ${pending() ? "text-warn-text" : "text-ink-muted"}`}>
                        {pending() ? t().stream.waitingApproval : t().stream.approval}
                      </Text>
                      <Text class="text-[12px] font-medium text-ink-secondary">{`· ${stage().who(msg())}`}</Text>
                    </View>
                    <View class="px-[16px] pt-[12px] pb-[14px]">
                      <If
                        when={isPromptEdit(card()?.kind_key)}
                        else={
                          <If
                            when={isInterfaceEdit(card()?.kind_key)}
                            else={<Text testID="approval-body" class="text-[14px] leading-[1.55] text-ink">{msg().body}</Text>}
                          >
                            <InterfaceEditCard
                              body={msg().body}
                              approval={card() ?? null}
                              api={runtime.client}
                              recent={stage().snapshot.interface?.recent ?? []}
                            />
                          </If>
                        }
                      >
                        <PromptEditCard
                          body={msg().body}
                          approval={card() ?? null}
                          api={runtime.client}
                          onOpenSettings={(target) => runtime.openPromptSettings(target)}
                        />
                      </If>
                      <If
                        when={pending() ? card() : undefined}
                        else={
                          <If when={card()}>
                            {(done: () => NonNullable<ReturnType<typeof card>>) => (
                              <View testID="approval-status" class="flex-row items-center gap-[6px] mt-[10px]">
                                <If when={done().status === "allowed_once"}>
                                  <Icon name="check" size={12} class="tint-ink-muted" />
                                </If>
                                <If when={done().status === "denied"}>
                                  <Icon name="x" size={12} class="tint-ink-muted" />
                                </If>
                                <Text class="text-[13px] text-ink-muted">{statusCopy(done().status)}</Text>
                              </View>
                            )}
                          </If>
                        }
                      >
                        {(open: () => NonNullable<ReturnType<typeof card>>) => {
                          const mcpAuth = () =>
                            isHttpMcpApproval(open().kind_key, open().target) || open().kind_key === "mcp-add" || open().kind_key === "mcp-edit";
                          const nextMode = () => modeAllowing(open().kind_key);
                          return (
                            <>
                              <If when={approvalNeedsSecret(open())}>
                                <View class="gap-[6px] mt-[12px]">
                                  <Text class="text-[12px] font-semibold text-ink-secondary">{mcpAuth() ? t().stream.mcpAuth : t().stream.endpointKey}</Text>
                                  <Input
                                    testID="approval-key"
                                    masked
                                    autoCorrect={false}
                                    autoCapitalize="none"
                                    accessibilityLabel={mcpAuth() ? t().stream.mcpAuth : t().stream.endpointKey}
                                    value={stage().approvalKeys[open().id] ?? ""}
                                    onChange={(e) => {
                                      const id = open().id;
                                      stage().approvalKeys = { ...stage().approvalKeys, [id]: e.value };
                                      if (stage().approvalKeyErrors[id]) stage().approvalKeyErrors = { ...stage().approvalKeyErrors, [id]: false };
                                    }}
                                    class="w-full px-[11px] py-[8px] border border-line rounded-(--radius-md) bg-input-bg text-[13px] text-ink focus:border-field-focus-border"
                                  />
                                  <If
                                    when={stage().approvalKeyErrors[open().id]}
                                    else={
                                      <Text testID="approval-key-hint" class="text-[12px] text-ink-muted">
                                        {mcpAuth()
                                          ? open().kind_key === "mcp-add"
                                            ? t().stream.mcpAuthHintAdd
                                            : t().stream.mcpAuthHintEdit
                                          : open().kind_key === "endpoint-add"
                                            ? t().stream.endpointKeyHintAdd
                                            : t().stream.endpointKeyHintEdit}
                                      </Text>
                                    }
                                  >
                                    <Text testID="approval-key-error" class="text-[12px] text-danger-text">
                                      {mcpAuth() ? t().stream.mcpAuthEmpty : t().stream.endpointKeyEmpty}
                                    </Text>
                                  </If>
                                </View>
                              </If>
                              <View class="flex-row flex-wrap gap-[8px] mt-[10px]">
                                <Button testID="approval-allow-once" variant="primary" icon="check" onPress={() => void resolveApprovalCard(open(), "allow_once")}>
                                  {t().stream.allowOnce}
                                </Button>
                                {/* Allowed from now on (ADR 0092): this Bot moves to the mode in which this kind no longer asks. */}
                                <Button testID="approval-allow-from-now" variant="secondary" onPress={() => void resolveApprovalCard(open(), "allow_from_now")}>
                                  {t().permissions.allowFromNow}
                                </Button>
                                <Button testID="approval-deny" variant="ghost" onPress={() => void resolveApprovalCard(open(), "deny")}>
                                  {t().stream.deny}
                                </Button>
                              </View>
                              <Text testID="approval-allow-note" class="mt-[8px] text-[12px] leading-[1.45] text-ink-muted">
                                {t().permissions.allowFromNowCovers(stage().who(msg()), t().permissions.modes[nextMode()], t().permissions.descriptions[nextMode()])}
                              </Text>
                            </>
                          );
                        }}
                      </If>
                    </View>
                  </View>
                </View>
              );
            }}
    </If>
  );
}
