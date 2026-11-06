/**
 * Your own Claude Code as the daemon finds it (ADR 0061; `settings/ClaudeAgentCard.svelte`): where
 * it is, which version, which account it is signed in with, and the other accounts' config
 * directories a Bot may run on. Deskfolk only runs it and asks it about itself; signing in is
 * Claude Code's own, in a terminal.
 *
 * Props: `api` (`ClaudeAgentApi`; null asks nothing); `onstatus(status)` (told each status read, so
 * the setup wizard can wait for a signed-in Claude Code); `embedded` (opened from Settings ›
 * Agents' list: no heading or frame); `usage` (Claude's usage, one line under each account
 * something runs on).
 * Test ids: the Svelte `data-claude-*` as `claude-*` (`claude-agent` the card, `claude-missing`,
 * `claude-network`, `claude-accounts`, `claude-account`, `claude-signed-out`, `claude-api-key`,
 * `claude-card-usage`, `claude-account-error`, `claude-account-open`, `claude-path-input`,
 * `claude-path-open`, `claude-recheck`), plus `claude-failed`, `claude-unreachable`,
 * `claude-path-save`, `claude-account-input`, `claude-account-add`, per listed account
 * `claude-account-<dir>` and `claude-account-remove-<dir>`.
 */
import { effect, signal, untracked, View } from "nsh";
import type { ClaudeCodeStatus, UsageAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { claudeAccountLabel, claudeAgentPaysPerToken } from "../../m/settings/claude-agent.ts";
import { UsageLine } from "../usage/UsageLine";
import { AccountBox, AccountsHeading, AgentError, AgentFrame, AgentInput, AgentNote, AgentTitle, AgentWarn, Code, Fact, FactText, QuietButton, Source, WrapRow } from "./agent-parts";
import { TextAction, XsButton } from "./provider-fields";

export type ClaudeAgentApi = {
  claudeCode: () => Promise<ClaudeCodeStatus>;
  detectClaudeCode: () => Promise<ClaudeCodeStatus>;
  setClaudeCodePath: (path: string | null) => Promise<ClaudeCodeStatus>;
  /** The other accounts' config directories, the whole list; absent from an older client. */
  setClaudeCodeAccounts?: (configDirs: string[]) => Promise<ClaudeCodeStatus>;
};

export function ClaudeAgentCard(props: {
  api: ClaudeAgentApi | null;
  onstatus?: (status: ClaudeCodeStatus) => void;
  embedded?: boolean;
  usage?: UsageAgent | null;
}) {
  const t = () => copy().claudeAgent;
  const status = signal<ClaudeCodeStatus | null>(null);
  const busy = signal(false);
  const failed = signal(false);
  const unavailable = signal(false);
  const pathDraft = signal("");
  const accountDraft = signal("");
  const accountError = signal<"in_use" | "invalid" | null>(null);
  /** The path field and the account field wait behind a link: Claude Code is mostly found, on one account. */
  const pathOpen = signal(false);
  const accountOpen = signal(false);

  async function run(work: (api: ClaudeAgentApi) => Promise<ClaudeCodeStatus>): Promise<void> {
    const api = props.api;
    if (!api || busy()) return;
    busy.set(true);
    failed.set(false);
    try {
      const next = await work(api);
      status.set(next);
      unavailable.set(false);
      if (next.source === "setting" && next.path) pathDraft.set(next.path);
    } catch (error) {
      // Not there: a phone paired with a Mac on a Deskfolk from before the relay carried it.
      if ((error as { status?: number }).status === 404) unavailable.set(true);
      else failed.set(true);
    } finally {
      busy.set(false);
    }
  }

  /** Saves the whole list after an add or a removal; one a Bot runs on stays (409). */
  async function saveAccounts(configDirs: string[]): Promise<void> {
    const api = props.api;
    if (!api?.setClaudeCodeAccounts || busy()) return;
    busy.set(true);
    failed.set(false);
    accountError.set(null);
    try {
      status.set(await api.setClaudeCodeAccounts(configDirs));
      accountDraft.set("");
      accountOpen.set(false);
    } catch (error) {
      const code = (error as { status?: number }).status;
      if (code === 409) accountError.set("in_use");
      else if (code === 422) accountError.set("invalid");
      else failed.set(true);
    } finally {
      busy.set(false);
    }
  }

  // Asks once per client. `run` reads and writes `busy`, so it runs untracked: tracked, every
  // answer would set off the next ask.
  effect(() => {
    if (!props.api) return;
    untracked(() => void run((client) => client.claudeCode()));
  });

  effect(() => {
    const current = status();
    if (current) untracked(() => props.onstatus?.(current));
  });

  const account = () => {
    const current = status();
    return current && current.path && current.logged_in !== false ? claudeAccountLabel(current, copy()) : null;
  };
  /** Where the daemon's own environment signs in from, as Claude Code reports it. */
  const ownDir = () => status()?.accounts?.find((entry) => entry.config_dir === null)?.config_directory ?? null;
  const listed = () => status()?.accounts?.filter((entry) => entry.config_dir !== null) ?? [];
  const listedDirs = () => listed().map((entry) => entry.config_dir!);
  const canSetAccounts = () => props.api?.setClaudeCodeAccounts !== undefined;
  /** An account's usage when something runs on it; signed out is said above it already. */
  const usageOf = (dir: string | null) => props.usage?.accounts.find((entry) => (entry.config_dir ?? null) === dir && entry.reason !== "signed_out") ?? null;
  const usageBlock = (dir: string | null) => (
    <If when={usageOf(dir)}>
      {(entry) => (
        <View testID="claude-card-usage">
          <UsageLine account={entry()} />
        </View>
      )}
    </If>
  );
  const addAccount = () => {
    const dir = accountDraft().trim();
    if (dir) void saveAccounts([...listedDirs(), dir]);
  };

  return (
    <AgentFrame label={t().title} testID="claude-agent" embedded={props.embedded}>
      <If when={!props.embedded}>
        <AgentTitle runner="claude_code" title={t().title} tip={t().hint} tipLabel={t().help} />
      </If>
      <If when={unavailable()} else={body()}>
        <AgentNote testID="claude-unreachable">{t().unreachable}</AgentNote>
      </If>
    </AgentFrame>
  );

  function body() {
    return (
      <>
        <If when={failed()}>
          <AgentError testID="claude-failed" text={t().failed} />
        </If>
        <If when={status()}>
          {(current) => (
            <If when={current().path} else={<AgentWarn testID="claude-missing">{t().notFound}</AgentWarn>}>
              <View class="flex-col gap-1">
                <Fact label={t().path}>
                  <Code>{current().path ?? ""}</Code>
                  <If when={current().source}>{(source) => <Source text={t().source[source()] ?? source()} />}</If>
                </Fact>
                <Fact label={t().version}>
                  <FactText>{current().version ?? "—"}</FactText>
                </Fact>
                <Fact label={t().network} testID="claude-network">
                  <If when={current().proxy} else={<FactText>{t().direct}</FactText>}>
                    {(proxy) => (
                      <>
                        <Code>{proxy()}</Code>
                        <If when={current().proxy_source}>{(source) => <Source text={t().proxySource[source()] ?? source()} />}</If>
                      </>
                    )}
                  </If>
                </Fact>
              </View>
              <If when={current().base_url_set}>
                <AgentNote>{t().baseUrl}</AgentNote>
              </If>
              <If when={current().outdated}>
                <AgentNote>{t().outdated(current().sdk_version)}</AgentNote>
              </If>
              <View testID="claude-accounts" class="flex-col gap-2 pt-[10px] border-t border-line">
                <AccountsHeading title={t().accounts.heading} tip={t().accounts.hint} tipLabel={t().accounts.help} />
                <AccountBox label={account() ?? t().methods.none} testID="claude-account">
                  <View class="flex-row items-start gap-2">
                    <View class="flex-1 min-w-0 flex-col gap-[2px]">
                      <View class="flex-row flex-wrap items-center gap-[6px]">
                        <FactText bold>{account() ?? t().methods.none}</FactText>
                        <View class="px-[6px] border border-line rounded-full">
                          <FactText muted size={11}>{t().accounts.defaultTag}</FactText>
                        </View>
                      </View>
                      <If when={ownDir()}>{(dir) => <Code size={11} muted>{dir()}</Code>}</If>
                    </View>
                  </View>
                  <If when={current().logged_in === false}>
                    <AgentWarn testID="claude-signed-out">{t().signedOut}</AgentWarn>
                  </If>
                  <If when={claudeAgentPaysPerToken(current())}>
                    <AgentWarn testID="claude-api-key">{t().apiKey}</AgentWarn>
                  </If>
                  {usageBlock(null)}
                </AccountBox>
                <Each of={listed()} key={(entry) => entry.config_dir ?? ""}>
                  {(entry) => (
                    <AccountBox label={entry().config_dir ?? ""} testID={`claude-account-${entry().config_dir}`}>
                      <View class="flex-row items-start gap-2">
                        <View class="flex-1 min-w-0 flex-col gap-[2px]">
                          <FactText bold>{entry().logged_in === false ? t().methods.none : claudeAccountLabel(entry(), copy())}</FactText>
                          <Code size={11} muted>{entry().config_dir ?? ""}</Code>
                        </View>
                        <If when={canSetAccounts()}>
                          <XsButton
                            label={t().accounts.remove}
                            testID={`claude-account-remove-${entry().config_dir}`}
                            disabled={busy()}
                            onPress={() => void saveAccounts(listedDirs().filter((dir) => dir !== entry().config_dir))}
                          />
                        </If>
                      </View>
                      <If when={entry().logged_in === false}>
                        <View class="flex-row flex-wrap items-center gap-x-[6px]">
                          <FactText>{t().accounts.signedOut}</FactText>
                          <Code>{entry().login_command ?? ""}</Code>
                        </View>
                      </If>
                      {usageBlock(entry().config_dir)}
                    </AccountBox>
                  )}
                </Each>
                <If when={accountError()}>
                  {(code) => <AgentError testID="claude-account-error" text={code() === "in_use" ? t().accounts.inUse : t().accounts.invalid} />}
                </If>
                <If when={current().accounts && canSetAccounts() && accountOpen()}>
                  <WrapRow>
                    <AgentInput
                      testID="claude-account-input"
                      class="grow basis-[220px]"
                      value={accountDraft()}
                      placeholder={t().accounts.placeholder}
                      disabled={busy()}
                      onChange={(value) => accountDraft.set(value)}
                      onSubmit={addAccount}
                    />
                    <XsButton label={t().accounts.add} testID="claude-account-add" disabled={busy() || !accountDraft().trim()} onPress={addAccount} />
                    <QuietButton
                      label={copy().agents.collapse}
                      testID="claude-account-collapse"
                      onPress={() => {
                        accountOpen.set(false);
                        accountDraft.set("");
                        accountError.set(null);
                      }}
                    />
                  </WrapRow>
                </If>
              </View>
            </If>
          )}
        </If>
        <If when={pathOpen() || (status() !== null && !status()?.path)}>
          <WrapRow>
            <AgentInput
              testID="claude-path-input"
              class="grow basis-[220px]"
              value={pathDraft()}
              placeholder={t().pathPlaceholder}
              disabled={busy()}
              onChange={(value) => pathDraft.set(value)}
              onSubmit={() => void run((client) => client.setClaudeCodePath(pathDraft().trim() || null))}
            />
            <XsButton
              label={t().pathSave}
              testID="claude-path-save"
              disabled={busy()}
              onPress={() => void run((client) => client.setClaudeCodePath(pathDraft().trim() || null))}
            />
            <If when={status()?.path}>
              <QuietButton label={copy().agents.collapse} testID="claude-path-collapse" onPress={() => pathOpen.set(false)} />
            </If>
          </WrapRow>
        </If>
        <WrapRow gap={12}>
          <XsButton label={busy() ? t().checking : t().recheck} testID="claude-recheck" disabled={busy()} onPress={() => void run((client) => client.detectClaudeCode())} />
          <If when={status()?.path && !pathOpen()}>
            <TextAction label={copy().agents.editPath} testID="claude-path-open" onPress={() => pathOpen.set(true)} />
          </If>
          <If when={status()?.path && status()?.accounts && canSetAccounts() && !accountOpen()}>
            <TextAction label={copy().agents.addAccount} testID="claude-account-open" onPress={() => accountOpen.set(true)} />
          </If>
        </WrapRow>
      </>
    );
  }
}
