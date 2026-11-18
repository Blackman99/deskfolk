# 代码结构守则

给在这个仓库里写代码的 agent 和贡献者。来自 2026-10 的大拆分：当时 17 个文件超过 2000 行，其中 `copy.ts`、`ChatStage.svelte`、`local-api.ts` 在 9 月已经拆过一次，后来又胀了回去。各模块的具体布局见 [`docs/development.md`](../development.md) 的「守护进程源码布局」「共用逻辑（`apps/desktop-nsh/app/src/m`）」；这里只写拆和放的规矩。

## 文件大小

- `scripts/line-budget.ts` 是 `pnpm test` 的第一步：受版本管理的源码文件（含测试）超过 2000 行就失败。`scripts/line-budget.json` 的 `allow` 现在是空的，不要往里加条目来让测试变绿。
- 一个文件过了 1000 行，加功能之前先想清楚它属于哪个子模块。等守卫红了再拆，往往要拆一大块，而且会和别人的改动冲突。
- 已经拆开的地方，新代码进子模块，入口文件只做装配和转发。胀回去的都是同一个原因：图省事，把新代码直接加进了入口文件。

## 新代码放在哪

| 区域 | 入口文件只管 | 新代码放进 |
|---|---|---|
| 协议包 | `packages/protocol/src/index.ts` 只做再导出 | 按主题的叶子文件（`sessions.ts`、`plans.ts`……）；`events.ts` 只导入别人，不被叶子导入 |
| 本机接口 | `apps/daemon/src/local-api.ts`：鉴权、websocket、回执、`dispatch` | `local-api/routes/<组>.ts`；字面路径排在 `:id` 前面；写操作必须同步返回（`mutate` 拿到 Promise 回 422） |
| store | `store/index.ts` 绑定方法 | 一个领域一个文件；跨领域的查询原语进 `store/shared.ts` |
| 迁移 | `store/migrate.ts` 的 `migrateSchema` 只排顺序 | 成块的迁移放 `store/<领域>-migration.ts`；索引只进迁移，不进 `SCHEMA_SQL` |
| 轮次引擎 | `engine/*.ts` 每个文件一个 `createX(deps)` 工厂 | 工厂大了就拆成子工厂，见下一节；`runTurn` 的跳循环在 `engine/lifecycle/hop-loop.ts`，新的一步写成一个函数，用 `"next"` / `"end"` / `"drop"` 告诉循环下一步 |
| 模型调用 | `completions.ts`：客户端和类型 | `completions/` 下的 `wire`、`sse`、`stream`、`anthropic`、`judge`、`caps`、`origin-gate` |
| 应用文案（`app/src/m/copy.ts`） | `copy.ts` 只拼装 | `copy/<命名空间>.ts`，导出 `zh` 和受 `CopyShape` 约束的 `en`；导入别名用 `<ns>Text`，不要和已有导出同名 |
| 应用运行时 | `apps/desktop-nsh/app/src/m/runtime.svelte.ts`（`MessengerRuntime`）对外是扁平的 `runtime.x`，只转发 | 子 store（`connection/`、`chat/`、`overlays/`、`search/`……），通过宿主适配器读 `api` / `sync` / `snapshot` / `selectedId`，每次都现读，因为测试会用 `Reflect.set(runtime, "api", …)` 换掉它 |
| API 客户端 | `app/src/m/local-api.ts` / `remote/api.ts` | 两边都一样的方法进 `api-base.ts` 的 `ApiBase`；只有真不一样的才留在各自类里 |
| 大界面组件（`app/src/ui/`） | 父组件只管布局和状态 | 子组件，放在同一区域的目录里；只为一个界面服务的纯函数放在它旁边的 `<name>.ts`，共用的、像 store 的逻辑进 `app/src/m` |

## 拆一个闭包工厂

`engine/stop.ts`、`engine/lifecycle.ts` 原来各是一个上千行的 `createX(deps)` 闭包，现在的拆法是：

1. 先画内部函数的调用图，用 TypeScript 按符号解析，不要按名字。参数名常和外面的函数同名（`hold`），按名字算会画出假环。
2. 把函数分成几组，组与组之间只能单向依赖：后面的组可以用前面的，前面的不用后面的。同一个环里的函数必须在同一组。
3. 每组写成 `createY(deps, 前几组…)`，开头从 `deps` 和前几组里解构出**同样的名字**。这样函数体一个字都不用改，比对能证明是纯搬迁。
4. 几个组都会改的 `let` 状态（如 `lifecycle.ts` 的 `dispatching`、`closing`）留在一处。解构拿到的是值的拷贝，赋值不会传回原处。
5. 搬动时连同前面的注释和空行一起搬。

## 抽重复逻辑

- 只合并逐字相同的副本，或者差别能完全由参数还原、每个调用处结果都和原来一样的副本。
- 同名但行为不同的函数（如 `requireString`、`emptyToNull`、`expandHome`）不要合并。改名，或者留着。
- 副本之间的差别不要顺手统一：统一就会改外观或行为，这类改动单独提交，带测试；面向用户的还要记 CHANGELOG。
- 写新代码前先找现成的：
  - **daemon**
    - `tool-result.ts` 的 `toolFail`。
    - `text.ts` 的按码点截断，以及中英择一的 `bilingual` / `sayIn`。
    - `ids.ts` 的 `ulid`、`isoNow`、`isUlid`、`isoPlus`。
    - `store/shared.ts` 的 `LIVE_TURN_STATUSES`、`planStageSql`、`jsonColumnOr`、`clock`。
    - 测试用 `test-kit/` 下的 `local-api-harness`、`until`、`engine-fixtures`。
  - **共用逻辑（`apps/desktop-nsh/app/src/m`）：工具函数**
    - 本地存储：`storage.ts` 的 `readStored` / `writeStored` / `forgetStored`；记住拖动宽度的 `persistedWidth`。
    - 小工具：`is-record.ts`、`locale-tag.ts`、`spend-format.ts`。
    - 界面方案（ADR 0106）：`interface/controller.svelte.ts` 的 `interfaceController`（每个窗口一个，套用、底线、回报），读用法用 `interface/behaviour.svelte.ts` 的 `interfaceBehaviour()`，改过的字走 `copy.ts` 的 `copyFor(locale, overrides)`；校验和打补丁在协议包的 `applyInterfacePatch`，两端共用。画代码的地方：代码配色取 `app/src/ui/code-colors.tsx`（`codeTheme(place)`、`codeSurface()`、`highlightCode`），不要自己挑主题。
    - 从外面来的文件：两个消息框都用 `app/src/ui/chat/composer-drop.tsx`（`stageUris` 读访达拖入、粘贴的 `file:` 地址并暂存，`pickInto` 是回形针，`sayLeftOut` 说哪些没加上，`DropVeil` 是拖着经过时的提示）；文件树的拖入在 `ArtifactTree` 的 `onDropFiles`，拷贝走 `ArtifactTreeSource.importDropped`。中英文案里列几个名字用 `m/copy/name-list.ts`。
    - 交互：`pointer-drag.ts`（拖动改宽高）、`autosave.svelte.ts`（边输边存）、`keymap.ts` 的 `isPrimaryModifier`；平台这一侧的 `app/src/platform/`（`press.ts` 的 `onPressOutside`、`wheel.ts`、`lifecycle.ts`、`viewport.ts` 的 `widthAtMost`）。
  - **界面组件（`apps/desktop-nsh/app/src/ui`，NSH TSX，写法见 `apps/desktop-nsh/PORTING.md`）**
    - `Button.tsx`、`IconButton.tsx`、`Icon.tsx`（图标表在 `m/icons.ts`）；右上角提示 `m/toast.svelte.ts` 的 `showToast`（`ToastHost.tsx` 外壳挂一个）。
    - `Switch.tsx`、`Checkbox.tsx`、`Select.tsx`、`MultiSelect.tsx`、`Modal.tsx`、`EmptyState.tsx`。
    - 手机上的下拉：`BottomSheet.tsx`（从底部升起的面板；一层层往下选的面板给 `onBack`；行用同文件的 `SheetItem`、`SheetSeparator`）；桌面弹出、手机底部弹出的选择器是 `Select`、`ModelPicker`。
    - 设置页：`settings/SettingsRow`、`SettingsCard`、`SettingsCardHeader`、`SettingsSubpageButton`、`AutosaveState`；分块标签和手机列表 `SettingsSectionTabs`、`SettingsSectionList`。
    - 提示词：`settings/PromptEditorPage`（编辑页，宽窗弹窗、手机内页）、`PromptRowList`（一行一条，带状态和读不懂次数），提示词页和「分工」页共用；`m/settings/prompts-view.ts` 的 `promptChip`。
    - 内置调用：`settings/SideModelCard`（一个调用的模型选择器）、`settings/CallEditor`（一个调用的模型和提示词，在流程环节的面板里就地改）、`m/settings/builtin-models.ts` 的 `builtinModelsOf` / `builtinPatch`；`m/settings/routing-map.ts` 的 `routingNodeView`、`promptsTabItems`、`askOnce`（整页只问一次状态）。
    - 编辑页：`panels/EditorOwnerBadge`、`EditorSwitchRow`、`RequiredStar`。
  - **应用：测试**
    - `m/test-async.ts`（`settle`、`settleTimers`、`deferred`）、`m/test-mocks.ts`（`fakeApi`）、`m/test-fixtures.ts`、`m/test-sync-harness.ts`。
    - 界面测试用 `app/.ui/fixture.ts` 的 `openStory` / `openApp`。

## 已知、有意没统一的差别

这些是拆分时发现、按当时的决定没动的地方。下面每一条，统一都会改外观或行为，所以要先定下结果，再单独提交、带测试。不要在别的改动里顺手改掉。

- 旧的 `publish` 通道（`local-api.ts` 的 `publishLegacy`）只有测试在用。
- 协议和 store 的 `Submission` 类型对不上（`origin`、`content`、`checks`、`awaiting`），`TicketStage` 也声明了两次。
- 字节和时长的格式化在不同地方输出不一样（`1m 12s` 与 `1m12s`）。
- 约 8 处自己判断 ⌘ / Ctrl，没用 `keymap.ts` 的 `isPrimaryModifier`。
- `occurred()` 和 `isoNow()` 两套时间。
- 约 25 处 `JSON.parse(row.x)` 遇到坏数据会抛错。
- 搬进 API 类的 9 个方法没带修订号。
- `clip` / `oneLine` / `handleCorner` 有几份不完全相同的副本。
- 「已复制」提示：设置里的三处一直亮着，聊天页的 1.8 秒后复原，而且卸载时没清计时器。
- 手机上，端点编辑的返回 / 关闭按钮宽 44px，其他页面是 40px；提示词编辑页没有关闭按钮。
- 技能、记忆、日程三个编辑页：表单间距 8 / 8 / 10px，开关行高 40 / 40 / 44px。

## 纯搬迁怎么做、怎么证明

- 拆文件和改行为分两个提交。拆的那个提交里，除了文件位置和导入，什么都不变。
- 用脚本搬：按名字移动声明，改写所有导入方，`import * as ns` 的 `ns.x` 用法也要改。不要手抄。main 在你拆的时候变了，就在新 main 上重跑脚本，不要去解搬过去的代码里的冲突。
- **daemon** 证明三件事：
  - 原文件的每条语句（连同前面的注释）在新文件里原样出现一次；
  - 导出面不变；
  - `tsc --noUnusedLocals` 的错误数不涨，涨了多半是脚本带进了多余的导入。
  - 拆测试文件时，再比一次测试名单。
- **逻辑和界面**：逻辑（`app/src/m`）靠 `*.test.ts` / `*.spec.ts` 和类型检查；界面靠 `apps/desktop-nsh/scripts/ui-tests.ts` 的故事和测试（按 `testID` 比行为）。菜单、子页、编辑页这类要点开才看到的状态，写进测试里点开再断言。截图只作参考：近似的颜色截图比不出来。
- 不是纯搬迁的结构改动（比如把 `runTurn` 切成几步），证明靠：
  - 改前改后各跑一次 `bun test --coverage`，没走到的行应是同一批；
  - 再用夹具 daemon 加假模型比一次事件流。

## 容易踩的坑

- `derived` 搬家后还是 `derived`（`app/src/lib/reactive.ts`，有缓存）。不要改成普通 getter：会丢掉缓存，放在循环里就成了平方级。界面里同理：每一行都读的派生值用 `computed`，不要写成函数。
- 有的测试按源码路径读文件，搬文件后它们会悄悄失效：
  - `apps/daemon/src/compiled-daemon.test.ts` 按 `packages/protocol/src/constants.ts` 改写端口。改漏了，编出来的测试 daemon 会连上真的 17890。
  - `copy-platform.spec.ts` 要清掉 `copy/` 模块的 `require.cache` 才能换平台重载。
  - `remote/isolation.spec.ts` 和 `remote/xss.spec.ts` 直接 grep 组件源码。
  - `apps/desktop-nsh/scripts/` 下的 `press-cursor.test.ts`、`list-content.test.ts`、`line-menu.test.ts`、`file-chip-menu.test.ts` 读界面源码查写法，搬界面文件后路径要跟着改。
- store 里有几条循环导入能跑，是因为互相调用都发生在函数里面。新文件不要在模块顶层读循环另一头的值，拆完要真起一次 daemon 看看。
- 全套测试的基线要在干净的 worktree 里跑。在正在改的 worktree 里跑，一跑好几分钟，中途会读到改了一半的文件。

## 和正在跑的 `pnpm dev` 共处

- `pnpm dev` 的开发运行时没有 watch 模式，保存 `apps/daemon` 或 `packages/` 下的文件不会重启它；但它一重启（你重启它，或别的会话、脚本重启它），正在跑的轮次就被打断，而且它每次启动读到的就是主工作区当时的文件。所以改 daemon 要在 worktree 里改，合入前确认没有活轮（`turns.status` 是 `running` / `waiting_approval` / `waiting_ask`），也避开整点前后（日程多设在整点，正好撞上重启就会被打断）。
- 几个文件一起写进主工作区时，要连着一次写完，每个中间状态都得能启动，因为随时可能有一次重启（或 NSH 应用的热重载）读到它。
- 夹具 daemon 加 `scripts/fake-openai.ts` 时，假模型在 127.0.0.1 上会被当成本地模型服务。它默认报的输入 token 数又太小，结果每一轮都按「超出上下文窗口」失败。要走正常路径，用一份把 `prompt_tokens` 改大的副本。比较两个版本的事件流时，给假模型加点延迟（`REAL_BOT_FAKE_STREAM_DELAY_MS`）：秒回的话，后台调用和下一跳谁先落地，取决于代码里有几层 `await`。
