/**
 * One of your local agents besides Claude Code (ADR 0079), as the daemon found it
 * (`settings/AgentCard.svelte`): where it is, which version, whether it is signed in, how it
 * reaches the network and which models it lists, with the other accounts' config directories a Bot
 * may run on for an agent that has them. Deskfolk only runs it and asks it about itself; signing
 * in is the agent's own, in a terminal. Its logo stands before its name; one of your own ACP agents
 * wears the plain prompt glyph.
 *
 * Props: `status` (the daemon's answer for this agent); `api` (`AgentCardApi`: `detectAgent`,
 * `setAgentPath`, `setAgentAccounts`; null does nothing); `custom` (for one of your own ACP agents:
 * its command and arguments); `onChange(status)` (the daemon's new answer after a check, a path or
 * an account list was set); `embedded` (opened from Settings › Agents' list, whose row already
 * names it: no heading or frame); `usage` (its usage, one line per account something runs on).
 * Test ids: the Svelte `data-agent-*` as `agent-*` (`agent-path`, `agent-version`, `agent-signin`,
 * `agent-network`, `agent-models`, `agent-usage`, `agent-missing`, `agent-failed`, `agent-error`,
 * `agent-path-input`, `agent-path-save`, `agent-path-open`, `agent-path-error`, `agent-recheck`,
 * `agent-account-open`, `agent-accounts`, `agent-account-input`, `agent-account-add`,
 * `agent-account-error`), per account `agent-account-<dir>` and `agent-usage-<dir>`.
 */
import { signal, untracked, View, type JSX } from "nsh";
import { AGENT_KINDS, type AgentStatus, type BotRunner, type CustomAgent, type UsageAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { agentAccountExample, agentCommand, agentFailure, type AgentFailure } from "../../m/settings/agents.ts";
import { UsageLine } from "../usage/UsageLine";
import { AccountBox, AccountsHeading, AgentError, AgentFrame, AgentInput, AgentNote, AgentTitle, AgentWarn, Code, Fact, FactText, QuietButton, Source, WrapRow } from "./agent-parts";
import { TextAction, XsButton } from "./provider-fields";

export type AgentCardApi = {
  detectAgent: (runner: BotRunner, customId?: string | null) => Promise<AgentStatus>;
  setAgentPath: (runner: BotRunner, path: string | null) => Promise<AgentStatus>;
  setAgentAccounts: (runner: BotRunner, configDirs: string[]) => Promise<AgentStatus>;
};

/** How an agent says it is signed in: the words, and the command to run when it is not. */
function signIn(entry: { logged_in: boolean | null; auth: string | null; login_command: string | null }): JSX.Element {
  const t = () => copy().agents;
  if (entry.logged_in === true) return <FactText>{t().signedIn(entry.auth)}</FactText>;
  if (entry.logged_in === false) {
    return entry.login_command ? (
      <>
        <FactText>{t().signedOut}</FactText>
        <Code>{entry.login_command}</Code>
      </>
    ) : (
      <FactText>{t().signedOutNoCommand}</FactText>
    );
  }
  return <FactText>{t().signInUnknown}</FactText>;
}

export function AgentCard(props: {
  status: AgentStatus;
  api: AgentCardApi | null;
  custom?: CustomAgent | null;
  onChange?: (status: AgentStatus) => void;
  embedded?: boolean;
  usage?: UsageAgent | null;
}) {
  const t = () => copy().agents;
  const busy = signal(false);
  const failed = signal(false);
  const pathDraft = signal(untracked(() => (props.status.source === "setting" && props.status.path ? props.status.path : "")));
  const pathFailure = signal<AgentFailure | null>(null);
  const accountDraft = signal("");
  const accountFailure = signal<AgentFailure | null>(null);
  /** The path field and the account field wait behind a link: most agents are found and have one account. */
  const pathOpen = signal(false);
  const accountOpen = signal(false);

  const kind = () => AGENT_KINDS[props.status.runner];
  const isCustom = () => props.status.runner === "custom";
  const command = () => agentCommand(props.status, props.custom);
  const configDirVar = () => kind().configDirVar;
  /** Your accounts besides the daemon's own environment, which the facts above already show. */
  const listed = () => props.status.accounts?.filter((entry) => entry.config_dir !== null) ?? [];
  const listedDirs = () => listed().map((entry) => entry.config_dir!);
  /** An account's usage when something runs on it; signed out is said beside it already. */
  const usageOf = (dir: string | null) => props.usage?.accounts.find((entry) => (entry.config_dir ?? null) === dir && entry.reason !== "signed_out") ?? null;
  const ownUsage = () => usageOf(null);

  async function run(work: (client: AgentCardApi) => Promise<AgentStatus>, onFail: (error: unknown) => void): Promise<void> {
    const api = props.api;
    if (!api || busy()) return;
    busy.set(true);
    failed.set(false);
    try {
      const next = await work(api);
      if (next.source === "setting" && next.path) pathDraft.set(next.path);
      props.onChange?.(next);
    } catch (error) {
      onFail(error);
    } finally {
      busy.set(false);
    }
  }

  function detect(): Promise<void> {
    pathFailure.set(null);
    return run((client) => client.detectAgent(props.status.runner, props.status.custom_id), () => failed.set(true));
  }

  function savePath(): Promise<void> {
    pathFailure.set(null);
    const path = pathDraft().trim() || null;
    return run(
      (client) => client.setAgentPath(props.status.runner, path),
      (error) => {
        const failure = agentFailure(error);
        if (failure.kind === "failed") failed.set(true);
        else pathFailure.set(failure);
      },
    );
  }

  /** Saves the whole list after an add or a removal; one a Bot runs on stays (409). */
  function saveAccounts(configDirs: string[]): Promise<void> {
    accountFailure.set(null);
    return run(
      async (client) => {
        const next = await client.setAgentAccounts(props.status.runner, configDirs);
        accountDraft.set("");
        accountOpen.set(false);
        return next;
      },
      (error) => {
        const failure = agentFailure(error);
        if (failure.kind === "failed") failed.set(true);
        else accountFailure.set(failure);
      },
    );
  }

  const addAccount = () => {
    const dir = accountDraft().trim();
    if (dir) void saveAccounts([...listedDirs(), dir]);
  };

  return (
    <AgentFrame label={props.status.label} testID={`agent-card-${props.status.runner}`} embedded={props.embedded}>
      <If when={!props.embedded}>
        <AgentTitle runner={props.status.runner} title={props.status.label} tip={t().hint(props.status.label)} tipLabel={t().help(props.status.label)} labelTestID="agent-label" />
      </If>
      <If when={failed()}>
        <AgentError testID="agent-failed" text={t().failed} />
      </If>
      <If
        when={props.status.path}
        else={
          <AgentWarn testID="agent-missing">{isCustom() ? t().notFoundCustom(command()) : t().notFound(command())}</AgentWarn>
        }
      >
        <View class="flex-col gap-1">
          <Fact label={isCustom() ? t().command : t().path} testID="agent-path">
            <Code>{props.status.path ?? ""}</Code>
            <If when={props.status.source}>{(source) => <Source text={t().source[source()] ?? source()} />}</If>
          </Fact>
          <If when={isCustom()}>
            <Fact label={t().args} testID="agent-args">
              <If when={props.custom && props.custom.args.length > 0} else={<FactText>{t().noArgs}</FactText>}>
                <Code>{(props.custom?.args ?? []).join(" ")}</Code>
              </If>
            </Fact>
          </If>
          <Fact label={t().version} testID="agent-version">
            <FactText>{props.status.version ?? "—"}</FactText>
          </Fact>
          <Fact label={t().signIn} testID="agent-signin">
            {signIn(props.status)}
          </Fact>
          <Fact label={t().network} testID="agent-network">
            <If when={props.status.proxy} else={<FactText>{t().direct}</FactText>}>
              {(proxy) => (
                <>
                  <Code>{proxy()}</Code>
                  <If when={props.status.proxy_source}>{(source) => <Source text={t().proxySource[source()] ?? source()} />}</If>
                </>
              )}
            </If>
          </Fact>
          <Fact label={t().models} testID="agent-models">
            <FactText>
              {props.status.models.length > 0 ? t().modelsCount(props.status.models.length, props.status.default_model) : t().modelsNone}
            </FactText>
          </Fact>
          <If when={ownUsage()}>
            {(own) => (
              <Fact label={copy().usage.title} testID="agent-usage">
                <UsageLine account={own()} />
              </Fact>
            )}
          </If>
        </View>
      </If>
      <If when={props.status.error && props.status.path}>
        <AgentNote testID="agent-error">{props.status.error ?? ""}</AgentNote>
      </If>
      <If when={props.status.runner === "antigravity"}>
        <AgentNote testID="agent-note-antigravity">{t().noteAntigravity}</AgentNote>
      </If>
      <If when={props.status.runner === "zcode"}>
        <AgentNote testID="agent-note-zcode">{t().noteZcode}</AgentNote>
      </If>
      <If when={configDirVar() && props.status.path && (listed().length > 0 || accountOpen())}>
        <View testID="agent-accounts" class="flex-col gap-2 pt-[10px] border-t border-line">
          <AccountsHeading title={t().accounts.heading} tip={t().accounts.hint(props.status.label, configDirVar() ?? "")} tipLabel={t().accounts.help} />
          <Each of={listed()} key={(entry) => entry.config_dir ?? ""}>
            {(entry) => (
              <AccountBox label={entry().config_dir ?? ""} testID={`agent-account-${entry().config_dir}`} gap={6}>
                <View class="flex-row items-start gap-2">
                  <View class="flex-1 min-w-0 flex-col gap-[2px]">
                    <Code size={11}>{entry().config_dir ?? ""}</Code>
                    <View class="flex-row flex-wrap items-center gap-x-[6px]">{signIn(entry())}</View>
                  </View>
                  <XsButton
                    label={t().accounts.remove}
                    testID={`agent-account-remove-${entry().config_dir}`}
                    disabled={busy()}
                    onPress={() => void saveAccounts(listedDirs().filter((dir) => dir !== entry().config_dir))}
                  />
                </View>
                <If when={entry().error}>{(error) => <AgentNote>{error()}</AgentNote>}</If>
                <If when={usageOf(entry().config_dir)}>
                  {(account) => (
                    <View testID={`agent-usage-${entry().config_dir}`}>
                      <UsageLine account={account()} />
                    </View>
                  )}
                </If>
              </AccountBox>
            )}
          </Each>
          <If when={accountFailure()}>
            {(failure) => (
              <AgentError
                testID="agent-account-error"
                text={failure().kind === "in_use" ? t().accounts.inUse : t().accounts.invalid}
                detail={failure().detail}
              />
            )}
          </If>
          <If when={accountOpen()}>
            <WrapRow>
              <AgentInput
                testID="agent-account-input"
                class="grow basis-[220px]"
                value={accountDraft()}
                placeholder={t().accounts.placeholder(agentAccountExample(props.status.runner))}
                disabled={busy()}
                onChange={(value) => accountDraft.set(value)}
                onSubmit={addAccount}
              />
              <XsButton label={t().accounts.add} testID="agent-account-add" disabled={busy() || !accountDraft().trim()} onPress={addAccount} />
              <QuietButton
                label={t().collapse}
                testID="agent-account-collapse"
                onPress={() => {
                  accountOpen.set(false);
                  accountDraft.set("");
                  accountFailure.set(null);
                }}
              />
            </WrapRow>
          </If>
        </View>
      </If>
      <If when={pathFailure()}>
        {(failure) => <AgentError testID="agent-path-error" text={t().pathInvalid} detail={failure().detail} />}
      </If>
      <If when={!isCustom() && (pathOpen() || !props.status.path)}>
        <WrapRow>
          <AgentInput
            testID="agent-path-input"
            class="grow basis-[220px]"
            value={pathDraft()}
            placeholder={t().pathPlaceholder(command())}
            disabled={busy()}
            onChange={(value) => pathDraft.set(value)}
            onSubmit={() => void savePath()}
          />
          <XsButton label={t().pathSave} testID="agent-path-save" disabled={busy()} onPress={() => void savePath()} />
          <If when={props.status.path}>
            <QuietButton
              label={t().collapse}
              testID="agent-path-collapse"
              onPress={() => {
                pathOpen.set(false);
                pathFailure.set(null);
              }}
            />
          </If>
        </WrapRow>
      </If>
      <WrapRow gap={12}>
        <XsButton label={busy() ? t().checking : t().recheck} testID="agent-recheck" disabled={busy()} onPress={() => void detect()} />
        <If when={!isCustom() && props.status.path && !pathOpen()}>
          <TextAction label={t().editPath} testID="agent-path-open" onPress={() => pathOpen.set(true)} />
        </If>
        <If when={configDirVar() && props.status.path && !accountOpen()}>
          <TextAction label={t().addAccount} testID="agent-account-open" onPress={() => accountOpen.set(true)} />
        </If>
      </WrapRow>
    </AgentFrame>
  );
}
