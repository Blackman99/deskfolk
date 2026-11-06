/**
 * The skill sheet (`SkillEditor.svelte`): name, when to use it, the Markdown body, the MCP tools it
 * relies on, and whether it is on. ProfilePane renders it after the pane, not inside the skills
 * tab. A desktop dialog; a whole page on a phone, with the Bot's name under the title and the
 * delete as a card at the end of the page.
 */
import { Input } from "nsh/base";
import { Text, View } from "nsh";
import type { Bot } from "@real-bot/protocol";
import type { SkillDraft, SkillFieldErrors } from "../../m/panels/create-form";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { Switch } from "../Switch";
import { EditorOwnerBadge } from "./EditorOwnerBadge";
import { EditorSwitchRow } from "./EditorSwitchRow";
import { RequiredStar } from "./RequiredStar";
import { SettingsSubject } from "./SettingsSubject";
import { FIELD, FIELD_ERROR } from "./panel-card";

function Card(props: { testID?: string; children: import("nsh").JSX.Element }) {
  return (
    <View testID={props.testID} class={`flex-col gap-2 border border-line bg-pane ${narrowWindow() ? "px-4 py-[14px] rounded-(--radius-lg)" : "px-[14px] py-3 rounded-(--radius-md)"}`}>
      {props.children}
    </View>
  );
}

function CardHeader(props: { label: string; required?: boolean; children?: import("nsh").JSX.Element }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <Text class="text-[13px] font-semibold text-ink">
        {props.label} <If when={props.required}><RequiredStar /></If>
      </Text>
      {props.children}
    </View>
  );
}

function Field(props: { testID: string; value: string; placeholder: string; invalid?: boolean; busy: boolean; onChange: (v: string) => void }) {
  return (
    <Input
      testID={props.testID}
      accessibilityLabel={props.placeholder}
      value={props.value}
      placeholder={props.placeholder}
      readonly={props.busy}
      autoCorrect={false}
      onChange={(e) => props.onChange(e.value)}
      class={`${FIELD} ${props.invalid ? "border-warn-line" : ""}`}
    />
  );
}

const Hint = (props: { children: string }) => <Text class="text-[12px] text-ink-muted">{props.children}</Text>;

export function SkillEditor(props: {
  bot: Bot;
  skillEditor: "add" | string | null;
  skillDraft: SkillDraft;
  /** The Svelte `bind:skillDraft`: the change goes out whole. */
  onDraftChange: (draft: SkillDraft) => void;
  skillErrors: SkillFieldErrors;
  skillFailed: boolean;
  skillBusy: boolean;
  closeSkillEditor: () => void;
  saveSkill: () => Promise<void>;
  openDeleteSkillConfirm: (id: string) => void;
}) {
  const t = () => copy().sidebar;
  const set = (change: Partial<SkillDraft>) => props.onDraftChange({ ...props.skillDraft, ...change });
  const nameCopy = () => (props.skillErrors.name === "conflict" ? t().skillNameConflict : t().skillNameEmpty);
  const editingId = () => (props.skillEditor && props.skillEditor !== "add" ? props.skillEditor : null);
  return (
    <If when={props.skillEditor}>
      {(editor) => (
        <Modal
          testID="skill-editor"
          title={editor() === "add" ? t().skillAdd : t().skillEdit}
          closeLabel={copy().common.close}
          backLabel={copy().common.back}
          busy={props.skillBusy}
          pageOnPhone
          width={520}
          maxHeight={0.88}
          subject={<SettingsSubject variant="line" bot={props.bot} />}
          onClose={props.closeSkillEditor}
          foot={
            <If
              when={!narrowWindow()}
              else={
                <ModalAction kind="primary" testID="skill-save" busy={props.skillBusy} onPress={() => void props.saveSkill()}>
                  {props.skillBusy ? copy().routines.busy : t().skillSave}
                </ModalAction>
              }
            >
              <View class="flex-row items-center justify-between w-full">
                <View class="flex-row items-center gap-2">
                  <If when={editingId()}>
                    {(id) => (
                      <ModalAction kind="deny" testID="skill-delete" icon="trash" disabled={props.skillBusy} onPress={() => props.openDeleteSkillConfirm(id())}>
                        {t().skillDelete}
                      </ModalAction>
                    )}
                  </If>
                </View>
                <View class="flex-row items-center gap-2">
                  <ModalAction testID="skill-cancel" disabled={props.skillBusy} onPress={props.closeSkillEditor}>{t().skillCancel}</ModalAction>
                  <ModalAction kind="primary" testID="skill-save" disabled={props.skillBusy} onPress={() => void props.saveSkill()}>{t().skillSave}</ModalAction>
                </View>
              </View>
            </If>
          }
          bodyClass={narrowWindow() ? "px-3 pt-4 pb-6 gap-[14px]" : "px-[22px] py-[18px] gap-[14px]"}
        >
          <If when={props.skillFailed}>
            <View role="alert" testID="skill-failed" class="flex-row items-center gap-2 px-[14px] py-[10px] rounded-(--radius-md) bg-danger-bg border border-danger-line">
              <Icon name="alert-circle" class="tint-danger-text" />
              <Text class="text-[13px] font-medium text-danger-text">{t().saveFailed}</Text>
            </View>
          </If>

          <Card>
            <CardHeader label={t().skillName} required>
              <EditorOwnerBadge name={props.bot.name} title={`${copy().routines.owner}: ${props.bot.name}`} />
            </CardHeader>
            <Field testID="skill-name" value={props.skillDraft.name} onChange={(v) => set({ name: v })} placeholder="例如：web_search, git_commit" invalid={!!props.skillErrors.name} busy={props.skillBusy} />
            <If when={props.skillErrors.name}>
              <Text testID="skill-name-error" class={FIELD_ERROR}>{nameCopy()}</Text>
            </If>
          </Card>

          <Card>
            <CardHeader label={t().skillDescription} required>
              <Hint>何时自动调用</Hint>
            </CardHeader>
            <Input
              testID="skill-description"
              accessibilityLabel={t().skillDescription}
              multiline
              value={props.skillDraft.description}
              placeholder="描述此技能适用的场景或触发条件，方便模型识别何时使用..."
              readonly={props.skillBusy}
              onChange={(e) => set({ description: e.value })}
              class={`${FIELD} min-h-[72px] ${props.skillErrors.description ? "border-warn-line" : ""}`}
            />
            <If when={props.skillErrors.description}>
              <Text testID="skill-description-error" class={FIELD_ERROR}>{t().skillDescriptionEmpty}</Text>
            </If>
          </Card>

          <Card>
            <CardHeader label={t().skillBody} required>
              <Hint>Markdown 指令</Hint>
            </CardHeader>
            <Input
              testID="skill-body"
              accessibilityLabel={t().skillBody}
              multiline
              autoCorrect={false}
              value={props.skillDraft.body}
              placeholder="输入具体的 Markdown 指令、规则或提示词内容..."
              readonly={props.skillBusy}
              onChange={(e) => set({ body: e.value })}
              class={`${FIELD} font-mono text-[13px] min-h-[140px] ${props.skillErrors.body ? "border-warn-line" : ""}`}
            />
            <If when={props.skillErrors.body}>
              <Text testID="skill-body-error" class={FIELD_ERROR}>{t().skillBodyEmpty}</Text>
            </If>
          </Card>

          <Card>
            <CardHeader label={t().skillUses}>
              <Hint>可选</Hint>
            </CardHeader>
            <Field testID="skill-uses" value={props.skillDraft.uses} onChange={(v) => set({ uses: v })} placeholder={t().skillUsesPlaceholder} busy={props.skillBusy} />
            <Text class="text-[12px] text-ink-muted">{t().skillUsesHint}</Text>
          </Card>

          <Card>
            <EditorSwitchRow
              testID="skill-enabled-row"
              title={t().skillEnabled}
              desc={props.skillDraft.enabled ? "已启用，Bot 在匹配任务中将自动读取并执行" : "已停用，Bot 将暂时忽略此技能"}
            >
              <Switch
                testID="skill-enabled"
                label={t().skillEnabled}
                disabled={props.skillBusy}
                checked={props.skillDraft.enabled}
                onChange={(checked) => set({ enabled: checked })}
              />
            </EditorSwitchRow>
          </Card>

          <If when={narrowWindow() ? editingId() : null}>
            {(id) => (
              <View
                role="button"
                testID="skill-page-delete"
                accessibilityLabel={t().skillDelete}
                disabled={props.skillBusy}
                onPress={() => props.openDeleteSkillConfirm(id())}
                class="flex-row items-center justify-center gap-2 w-full min-h-[44px] rounded-(--radius-md) border border-danger-line bg-danger-bg disabled:opacity-[0.45]"
              >
                <Icon name="trash" class="tint-danger-text" />
                <Text class="text-[14px] font-semibold text-danger-text">{t().skillDelete}</Text>
              </View>
            )}
          </If>
        </Modal>
      )}
    </If>
  );
}
