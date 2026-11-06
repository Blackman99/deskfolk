/**
 * The new-Bot dialog (`CreateBotSheet.svelte`): a template, the avatar, name, duties and
 * boundaries, who runs its turns (the app's loop, Claude Code or another local agent), the model
 * (and, on the app's loop, a thinking level), and the engine of its direct. A desktop dialog; a
 * whole page on a phone. Mounted only while open, so a fresh mount is the reset: with no endpoint a
 * Bot could run on, the form starts on the agent the setup chose (ADR 0078, ADR 0079).
 *
 * Props: `onClose`. The Bot is made through `runtime.createBot`, which closes the sheet itself when
 * it lands; a refusal is shown on its field, or on top.
 */
import { effect, signal, Text, untracked, View } from "nsh";
import { AGENT_KINDS, BUILTIN_PLAYBOOK_IDS, type AgentsStatusResponse } from "@real-bot/protocol";
import { templatesFor, type BotTemplate, type BotTemplateId } from "../../m/bot-templates";
import { claudeModelsOf, loadClaudeModels } from "../../m/claude-models.svelte";
import { thinkingLevelLabel } from "../../m/copy";
import {
  agentModelPicker,
  applyModelPin,
  botNameErrorCopy,
  claudeModelPicker,
  endpointModelPicker,
  mapCreateBotError,
  pickerValues,
  pinnableThinkingLevels,
  planCreateBot,
  type CreateBotDraft,
  type CreateBotFieldErrors,
} from "../../m/panels/create-form";
import { agentBlocker, agentLabelOf, agentStatusOf, parseRunnerValue, runnerOptions, setupRunnerOf } from "../../m/runner-choice";
import { playbookName, Playbooks } from "../../m/settings/playbooks.svelte";
import { copy, runtime } from "../../runtime";
import { AvatarEditor } from "../AvatarEditor";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { ModelPicker } from "../ModelPicker";
import { Select } from "../Select";
import { Chip, Field, FieldError, FieldHint, TextField } from "../settings/provider-fields";

export function CreateBotSheet(props: { onClose: () => void }) {
  const t = () => copy();
  const draft = signal<CreateBotDraft>({
    name: "",
    duties: "",
    boundaries: "",
    avatar: "",
    model: "",
    thinkingLevel: "",
    runner: untracked(() => {
      const { providers, settings } = runtime.snapshot;
      return setupRunnerOf(providers, settings.builtin_models?.reader ?? settings.reader_model);
    }),
  });
  const set = (patch: Partial<CreateBotDraft>) => draft.set({ ...draft(), ...patch });
  const errors = signal<CreateBotFieldErrors>({});
  const failed = signal(false);

  /** What the daemon finds of your other local agents; the runner picker lists them. Asked once, on opening. */
  const agents = signal<AgentsStatusResponse | null>(null);
  const playbooks = new Playbooks(() => runtime.client);
  const template = signal<BotTemplateId | null>(null);
  const playbookId = signal("");
  const client = runtime.client;
  if (client) {
    void playbooks.load();
    void (async () => {
      try {
        agents.set(await client.agents());
      } catch {
        // The phone, or a daemon older than local agents: only the app's loop and Claude are offered.
        agents.set(null);
      }
    })();
  }

  const runner = () => draft().runner ?? "";
  const runnerChoices = () => runnerOptions(t(), agents(), runner());
  const runnerPick = () => parseRunnerValue(runner());
  const agentRunner = () => (runnerPick().runner && runnerPick().runner !== "claude_code" ? runnerPick().runner : null);
  const agentName = () => {
    const r = agentRunner();
    return r ? agentLabelOf(r, runnerPick().customId, agents()) : "";
  };
  const agentStatus = () => {
    const r = agentRunner();
    return r ? agentStatusOf(agents(), r, runnerPick().customId) : null;
  };
  const agentBlocked = () => agentBlocker(agentStatus());
  const engineOptions = () => [
    { value: "", label: t().playbooks.followDefault(playbookName(playbooks.find(playbooks.defaultId), t().playbooks.builtin)) },
    ...playbooks.items.map((item) => ({ value: item.id, label: playbookName(item, t().playbooks.builtin) })),
  ];

  const providers = () => runtime.snapshot.providers;
  // Claude Code's own models, asked for once Claude Agent is picked (the computer's own account: a new Bot has no other yet).
  effect(() => {
    const api = runtime.client;
    if (runner() === "claude_code") untracked(() => loadClaudeModels(api, null));
  });
  const endpointModels = () => endpointModelPicker(providers(), t());
  const modelValues = () => pickerValues(endpointModels());
  const thinkingOptions = () => pinnableThinkingLevels(draft().model, providers());

  function onInput(): void {
    errors.set({});
    failed.set(false);
  }

  function useTemplate(picked: BotTemplate): void {
    const text = t().templates.templates[picked.id]!;
    set({ name: text.name, duties: text.duties, boundaries: text.boundaries });
    template.set(picked.id);
    playbookId.set(picked.playbook === playbooks.defaultId ? "" : picked.playbook);
    onInput();
  }

  /** Another agent names its models its own way: a model picked for one is not carried to the next. */
  function onRunnerChange(value: string): void {
    set({ runner: value, agentModel: undefined });
    onInput();
  }

  function onModelChange(value: string): void {
    const pinned = applyModelPin(value, draft().thinkingLevel ?? "", providers());
    set({ model: pinned.model, thinkingLevel: pinned.thinkingLevel });
    onInput();
  }

  async function save(): Promise<void> {
    failed.set(false);
    errors.set({});
    const plan = planCreateBot(draft(), modelValues());
    if (!plan.ok) {
      errors.set(plan.errors);
      return;
    }
    const id = playbookId();
    const error = await runtime.createBot(id && playbooks.list ? { ...plan.body, playbook_id: id } : plan.body);
    if (!error) return;
    const mapped = mapCreateBotError(error.status, error.message);
    if ("top" in mapped) failed.set(true);
    else errors.set(mapped);
  }

  return (
    <Modal
      testID="create-bot-sheet"
      title={t().sidebar.addBot}
      closeLabel={t().common.close}
      backLabel={t().common.back}
      pageOnPhone
      width={500}
      maxHeight={0.88}
      onClose={props.onClose}
      bodyClass={narrowWindow() ? "px-4 py-[18px] gap-4" : "px-6 py-5 gap-4"}
      foot={
        <>
          <ModalAction kind="primary" testID="bot-save" onPress={() => void save()}>
            {t().sidebar.create}
          </ModalAction>
          <ModalAction testID="bot-cancel" onPress={props.onClose}>
            {t().common.close}
          </ModalAction>
        </>
      }
    >
      <If when={failed()}>
        <FieldError testID="bot-failed">{t().sidebar.saveFailed}</FieldError>
      </If>

      <View testID="bot-templates" class="flex-col gap-1">
        <Text class={`${narrowWindow() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary mb-[2px]`}>{t().templates.fromTemplate}</Text>
        <View class="flex-col gap-[6px]">
          <Each of={BUILTIN_PLAYBOOK_IDS.filter((way) => templatesFor(way).length > 0)} key={(way) => way}>
            {(way) => (
              <View class="flex-row flex-wrap items-center gap-x-[10px] gap-y-[6px]">
                <Text class="text-[12px] text-ink-muted">{t().playbooks.builtin[way()]}</Text>
                <Each of={templatesFor(way())} key={(item) => item.id}>
                  {(item) => (
                    <Chip
                      testID={`bot-template-${item().id}`}
                      label={t().templates.templates[item().id]!.name}
                      active={template() === item().id}
                      onPress={() => useTemplate(item())}
                    />
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      </View>

      <Field label={t().sidebar.botAvatar}>
        <AvatarEditor
          name={draft().name}
          avatar={draft().avatar}
          onAvatarChange={(avatar) => set({ avatar })}
          onChange={onInput}
        />
      </Field>

      <Field label={t().sidebar.botName}>
        <TextField testID="bot-name" label={t().sidebar.botName} value={draft().name} invalid={Boolean(errors().name)} onInput={(name) => (set({ name }), onInput())} />
        <If when={errors().name}>{(code) => <FieldError testID="bot-name-error">{botNameErrorCopy(code(), t().sidebar)}</FieldError>}</If>
      </Field>

      <Field label={t().sidebar.botDuties}>
        <TextField testID="bot-duties" label={t().sidebar.botDuties} multiline value={draft().duties} invalid={Boolean(errors().duties)} onInput={(duties) => (set({ duties }), onInput())} />
        <If when={errors().duties}>
          <FieldError testID="bot-duties-error">{t().sidebar.dutiesEmpty}</FieldError>
        </If>
      </Field>

      <Field label={t().sidebar.botBoundaries}>
        <TextField testID="bot-boundaries" label={t().sidebar.botBoundaries} multiline value={draft().boundaries} invalid={Boolean(errors().boundaries)} onInput={(boundaries) => (set({ boundaries }), onInput())} />
        <If when={errors().boundaries}>
          <FieldError testID="bot-boundaries-error">{t().sidebar.boundariesEmpty}</FieldError>
        </If>
      </Field>

      <Field label={t().sidebar.botRunner}>
        <Select testID="bot-runner" ariaLabel={t().sidebar.botRunner} value={runner()} options={runnerChoices()} error={Boolean(errors().agentCustomId)} onChange={onRunnerChange} />
        <If
          when={errors().agentCustomId}
          else={
            <If
              when={agentRunner()}
              else={<FieldHint testID="bot-runner-hint">{runner() === "claude_code" ? t().sidebar.botRunnerClaudeCreateHint : t().sidebar.botRunnerAppHint}</FieldHint>}
            >
              {(picked) => (
                <>
                  <If
                    when={agentBlocked() === "missing"}
                    else={
                      <If
                        when={agentBlocked() === "signed_out"}
                        else={<FieldHint testID="bot-runner-hint">{t().sidebar.botRunnerAgentCreateHint(agentName())}</FieldHint>}
                      >
                        <FieldError testID="runner-signed-out">{t().sidebar.botRunnerAgentSignedOut(agentName(), agentStatus()?.login_command ?? null)}</FieldError>
                      </If>
                    }
                  >
                    <FieldError testID="runner-missing">{t().sidebar.botRunnerAgentMissing(agentName(), AGENT_KINDS[picked()].command)}</FieldError>
                  </If>
                  <If when={!AGENT_KINDS[picked()].appTools}>
                    <FieldHint testID="runner-note">{t().sidebar.botRunnerNoAppTools(agentName())}</FieldHint>
                  </If>
                </>
              )}
            </If>
          }
        >
          <FieldError testID="bot-runner-error">{t().sidebar.botRunnerCustomInvalid}</FieldError>
        </If>
      </Field>

      <If
        when={!runner()}
        else={
          <If
            when={runner() === "claude_code"}
            else={
              <If when={agentRunner()}>
                {(picked) => (
                  <Field label={t().sidebar.botAgentModelOf(agentName())}>
                    <ModelPicker
                      testID="bot-agent-model"
                      value={draft().agentModel ?? ""}
                      data={agentModelPicker(agents(), t(), picked(), runnerPick().customId, draft().agentModel ?? "")}
                      title={t().sidebar.botAgentModelOf(agentName())}
                      error={Boolean(errors().agentModel)}
                      onChange={(agentModel) => (set({ agentModel }), onInput())}
                    />
                    <If
                      when={errors().agentModel}
                      else={<FieldHint>{t().sidebar.botAgentModelEmptyHint(agentName(), agentStatus()?.default_model ?? null)}</FieldHint>}
                    >
                      <FieldError testID="bot-agent-model-error">{t().sidebar.botAgentModelInvalidOf(agentName())}</FieldError>
                    </If>
                  </Field>
                )}
              </If>
            }
          >
            <Field label={t().sidebar.botAgentModel}>
              <ModelPicker
                testID="bot-agent-model"
                value={draft().agentModel ?? ""}
                data={claudeModelPicker(t(), draft().agentModel ?? "", claudeModelsOf(null))}
                title={t().sidebar.botAgentModel}
                error={Boolean(errors().agentModel)}
                onChange={(agentModel) => (set({ agentModel }), onInput())}
              />
              <If when={errors().agentModel}>
                <FieldError testID="bot-agent-model-error">{t().sidebar.botAgentModelInvalid}</FieldError>
              </If>
            </Field>
          </If>
        }
      >
        <Field label={t().sidebar.botModel}>
          <ModelPicker
            testID="bot-model"
            value={draft().model}
            data={endpointModels()}
            placeholder={t().sidebar.botModelDefault}
            title={t().sidebar.botModel}
            error={Boolean(errors().model)}
            onChange={onModelChange}
          />
          <If
            when={errors().model}
            else={
              <If when={!draft().model}>
                <FieldHint testID="bot-model-hint">{t().sidebar.botModelAutoHint}</FieldHint>
              </If>
            }
          >
            <FieldError testID="bot-model-error">{t().sidebar.botModelInvalid}</FieldError>
          </If>
        </Field>
        <If when={draft().model}>
          <Field label={t().sidebar.botThinking}>
            <View role="radiogroup" accessibilityLabel={t().sidebar.botThinking} testID="bot-thinking" class="flex-row flex-wrap gap-[6px]">
              <Each of={thinkingOptions()} key={(level) => level}>
                {(level) => (
                  <Chip
                    role="radio"
                    testID={`bot-thinking-${level()}`}
                    label={thinkingLevelLabel(t().sidebar.thinkingLevels, level())}
                    active={draft().thinkingLevel === level()}
                    onPress={() => (set({ thinkingLevel: level() }), onInput())}
                  />
                )}
              </Each>
            </View>
            <FieldHint>{t().sidebar.botThinkingHint}</FieldHint>
            <If when={errors().thinkingLevel}>
              <FieldError testID="bot-thinking-error">{t().sidebar.botThinkingInvalid}</FieldError>
            </If>
          </Field>
        </If>
      </If>

      <If when={playbooks.list}>
        <View testID="bot-engine-field">
          <Field label={t().playbooks.label}>
            <Select testID="bot-engine" ariaLabel={t().playbooks.label} value={playbookId()} options={engineOptions()} onChange={(value) => playbookId.set(value)} />
            <FieldHint>{t().templates.engineHint}</FieldHint>
          </Field>
        </View>
      </If>
    </Modal>
  );
}
