# 只用 Claude Code 完成设置 / Setting up on Claude Code alone

Status: implemented 2026-10-10, at every engine level. Builds on [ADR 0061](0061-claude-agent-runner.md) (Claude Agent) and [ADR 0077](0077-built-in-models.md) (built-in models).

## 背景 / Context

你说（2026-10-10）：「第一次安装应用后的指导步骤里要支持用户配置定义端点或者直接连接本地 agent。」问到细处时你选了：第 2 步二选一，端点或本机 Claude Code；选 Claude Code 时不填端点也能完成向导，第一个 Bot 用 Claude Agent 跑，内置调用也用 Claude 模型。

在这之前，向导第 2 步只能填端点，`wizard_complete` 要工作区加一个能用的端点；装好并登录了 Claude Code、又没有 API key 的人，过不了向导。自定义端点本来就有（「自定义」预设）。

You said (2026-10-10): the first-run guide should let the user set up a custom endpoint or connect a local agent directly. Asked about the details, you chose: step 2 offers either an endpoint or the Claude Code on this computer; with Claude Code, the wizard completes with no endpoint, the first Bot runs as a Claude Agent, and the built-in calls run on a Claude model.

Until now step 2 took an endpoint only, and `wizard_complete` needed a workspace plus a usable endpoint: someone with Claude Code installed and signed in but no API key could not get past the wizard. A custom endpoint was already there (the Custom preset).

## 决定 / Decisions

1. **第 2 步二选一 / Step 2 offers two ways.** 「接模型端点」（原来的预设、自定义地址、本机服务）或「用本机 Claude Code」。后者在第 2 步显示设置里那张 Claude Agent 卡（路径、版本、网络、账号，可重新检测、填路径、加账号），找到已登录的 Claude Code 才能下一步；第 3 步选一个 Claude 模型（默认 `sonnet`）和账号（列了几个时）。/ "Model endpoint" (the presets, a custom address, a server on this computer) or "Claude Code on this computer". The latter shows the Settings' Claude Agent card in step 2 (path, version, network, accounts; check again, set a path, add an account) and goes on only once a signed-in Claude Code is found; step 3 picks one Claude model (`sonnet` by default) and the account, when more than one is listed.

2. **保存什么 / What is saved.** 先存工作区，再把九个内置调用都设成这个 Claude 模型和账号（`builtin_models`），不建端点。第一个 Bot 是 Claude Agent（`runner: "claude_code"`，同一个账号，模型用 Claude Code 自己的默认）。/ The workspace first, then all nine built-in calls on that Claude model and account (`builtin_models`); no endpoint is created. The first Bot is a Claude Agent (`runner: "claude_code"`, the same account, Claude Code's own default model).

3. **什么算完成 / What counts as complete.** `wizard_complete` = 工作区，加上能用的端点、或除压缩上下文外的八个内置调用都是 Claude 模型（`setUpOnClaudeCode`）。压缩上下文不算：它只在端点 Bot 的回合里跑，Claude Code 自己压缩。之后把其中一个调用改回「跟随默认」又没有端点时，向导重新出现——这时那个调用确实没有模型可用。/ `wizard_complete` = a workspace plus either a usable endpoint or the eight built-in calls other than compaction all on a Claude model (`setUpOnClaudeCode`). Compaction is left out: it only runs in an endpoint Bot's turn, and Claude Code compacts its own. Putting one of those calls back on the default with no endpoint brings the wizard back — that call then really has no model.

4. **没有端点时内置调用照样跑 / Built-in calls run without an endpoint.** 判断下场（`judgement`）、反思、完工复盘原来一看没有端点就跳过，连你选的 Claude 模型都不问；现在先看选的模型，选了 Claude 模型就照跑，两样都没有才跳过（反思和复盘照旧不认领，等有了模型再跑）。/ Judgements, reflections and retrospectives used to skip as soon as there was no endpoint, without asking for the Claude model you chose; now the chosen model comes first and a Claude model runs them, and only with neither do they skip (reflections and retrospectives still unclaimed, waiting for a model).

5. **之后的 Bot / Later Bots.** 没有能用的端点、又是只用 Claude Code 设置的，新建 Bot 没说谁来跑时就是 Claude Agent，账号用内置调用的那个（读句的账号）——Bot 用 `create_bot` 雇的队友也一样，否则它一轮都跑不了。这不算 Bot 替你选了你的账号：只用 Claude Code 是你设的，Bot 照旧不能指定或改 runner。名册里「新建 Bot」表单在没有能用的端点时默认选 Claude Agent。明说要应用自己跑（`runner: null`）的照办；加了端点之后不再自动换。（你在 2026-10-10 选的。）/ With no usable endpoint and setup on Claude Code alone, a new Bot made without saying what runs it is a Claude Agent on the account the built-in calls use (reading's) — a teammate a Bot hires with `create_bot` too, since it could not take a single turn otherwise. That is not a Bot choosing your account: you set up on Claude Code alone, and a Bot still cannot name or change a runner. The roster's new-Bot form starts on Claude Agent while there is no usable endpoint. An explicit `runner: null` is honored; once an endpoint is added nothing is switched by itself. (Your choice, 2026-10-10.)

## 后果 / Consequences

- **还要端点的 / What still needs an endpoint.** 端点上的 Bot（回合直接「连不上端点」）、模型阶梯（只在端点回合里爬）、从一串对话里学记忆和技能（`chains.ts` 的复盘和学习走默认端点、要用工具，没有对应的内置调用）。第 3 步的说明里写明了。/ Bots on an endpoint (their turns fail as unreachable), the model ladder (climbed only in an endpoint turn), and learning memories and skills from a chain (`chains.ts` review and learning run on the default endpoint with tools, and have no built-in call). Step 3 says so.
- **花费 / Cost.** 所有调用都花你 Claude 套餐的额度，整理器每个规划静下来都会跑一次（ADR 0077）。/ Every call spends your Claude plan's usage; the organizer runs each time a plan goes quiet (ADR 0077).
- **手机 / The phone.** 手机上的向导一样能选 Claude Code：Claude Agent 卡经中继问电脑上的 Claude Code。/ The wizard on the phone offers Claude Code as well: the Claude Agent card asks the computer's Claude Code over the relay.
