# 每种窗口在哪打开 / Where each kind of window opens

Status: implemented 2026-10-10, desktop workbench only. Amends one rule of [ADR 0025](0025-desktop-pane-workbench.md): opening something used to only add or replace a tab in the pane the keyboard is in, never split or float; now a new tab goes where its kind's choice says, and that choice can split or float.

你说的是（2026-10-10）：「支持配置给每种类型的窗口打开行为，包括会话，工具里的那些，流程图，看板，要点，产物等……行为包括：上下左右的某个方向分屏打开，浮窗打开，新标签页打开，替换标签页打开等等……给一组默认行为定义，本着方便使用的目标。」

在这之前，打开规则写死在 `pane-open.ts`：新东西一律进当前窗格当新标签；只有一块窗格时会话才替换会话；从不自动分屏。于是点消息里的文件、开这件事的流程或看板，都会盖住正在读的会话，终端也挤在同一排标签里。/ Before this, everything new became a tab in the focused pane, so a message's file or the job's board covered the conversation you were reading, and terminals piled into the same strip.

## 决定 / Decisions

1. **已经开着的不动，只决定新标签放哪 / What is open stays put; only a new tab is placed.** 0025 的另一半照旧：一条会话一个标签，一条会话一块产物预览、流程/看板/要点各一块，日程和花费各一块；再要一次只是把那一块切到前面（产物和流程转到新文件、新的那件事）。打开方式只在「哪儿都还没有它」的时候起作用，所以不会把你摆好的东西搬走。/ The one-of-each rules of 0025 still hold; a placement only applies when nothing shows the thing yet.

2. **十种窗口 / Ten kinds.** 会话（你 ↔ Bot、群、文件）、Bot ↔ Bot 私聊、流程、看板、要点、产物、工作区、终端、日程、花费。Bot ↔ Bot 私聊单列，因为它多半是从你自己会话里的卡片点进去、要和那条会话对照着读。流程的三个视图本来就各是一个标签，各算一种。/ A Bot↔Bot direct is its own kind because you usually open it from a card in your own conversation, to read beside it.

   不在列表里的：会话设置和 Bot 资料是会话标签里的侧栏，不是窗口；设置、全局搜索、新建 Bot 和群、归属这些是弹窗；图片放大和应用系统卡片上单个文件的全窗浮层不是标签；从某块窗格的「＋」或空窗格里挑的已经说了放哪块，就进那一块。桌面上的旧深链 `?o=trace`、`?o=workspace`、`?p=` 本来就开旧式浮层、不经过窗格，这次没动。/ Not covered: settings sidebars, dialogs, the image lightbox, the system card's file overlay, picks from a pane's own + or empty state (they name their pane), and the legacy desktop deep links, which never went through panes.

3. **十二种打开方式 / Twelve placements.** 分四组：
   - 标签页：新标签页；替换同类标签；后台新标签页（不切过去，键盘留在原处）。
   - 分屏（新开一块）：向右、向下、向左、向上。当前窗格是浮窗，或切开后放不下（`canSplit`），就退成新标签页。
   - 相邻窗格：右、下、左、上侧窗格。那一侧有窗格就放进去；当前窗格本身就在那一侧（例如在右栏里又开一个文件）就放进当前窗格；都不是才往那一侧分出一块。连开几个文件不会把窗口越切越碎。
   - 浮窗：浮在布局上。这种窗口上次浮着时你拖过或调过大小（松手那一下），就回到那个位置和大小，按当前窗口收一收；正好压在一块已有浮窗上就往右下错开。没拖过的居中，约工作台的 60% × 70%，不小于内容要的最小尺寸；已有浮窗时往右下错开 28 px，错开六次后回到正中。

   没有「新的系统窗口」：应用只有一个 Tauri 窗口，浮窗也不是第二个系统窗口（0025）。/ No "new OS window": there is one Tauri window.

4. **替换和相邻的细则 / The fine print of replace and neighbour.** 替换同类：当前窗格正显示同类就替换它；不是就从离键盘近的窗格找（当前那块，再按阅读顺序的平铺窗格，最后浮窗）第一块正显示同类的替换；那块有没保存的编辑（产物、工作区）就不替换、新开标签；都没有也新开标签。新标签放在被替换那个的位置上。「同类」是设置里的同一行：会话和 Bot ↔ Bot 私聊不算同类，流程、看板、要点各是一类，所以看板不会顶掉流程。分屏时在侧栏点另一条会话，替换的是正看着的会话，不会落进旁边的产物栏。相邻窗格看位置不看内容：从最左一块往右开，右边那块恰好是另一条会话，产物就叠进那块。/ Replace takes the same kind — the same row in the settings — in front, nearest the keyboard first, never one holding an unsaved edit; "neighbour" means position, not content.

5. **默认值 / Defaults.**

   | 窗口 | 默认 | 为什么 |
   |---|---|---|
   | 会话 | 替换同类标签 | 在侧栏里一条条点着看，不堆标签；分屏时换掉正读的那条，不碰旁边的东西 |
   | Bot ↔ Bot 私聊 | 右侧窗格 | 从自己会话里的卡片点进去，边看边对照 |
   | 流程、看板、要点 | 右侧窗格 | 会话在左，这件事的视图叠在右栏 |
   | 产物 | 右侧窗格 | 看文件不再盖住会话 |
   | 工作区 | 右侧窗格 | 和产物同一栏 |
   | 终端 | 下侧窗格 | 像编辑器的终端面板，后来的终端叠进同一块 |
   | 日程、花费 | 新标签页 | 大视图，整块看 |

   和以前比，有两处默认行为变了：分屏时点侧栏会话是替换正读的那条，而不是新开标签；产物、流程三视图、工作区、终端、Bot ↔ Bot 私聊不再进当前窗格，而是开到旁边或下面。/ Two defaults changed: a sidebar click in a split window replaces the conversation in front, and a conversation's own things open beside or under it.

6. **只记在这台机器上 / Kept on this machine.** 和布局一样存在 `localStorage`（`real-bot-open-placement`），只存和默认不同的项，以后默认改得更好，没改过的人直接拿到。浮窗最后被拖到的位置和大小按窗口种类另存在 `real-bot-open-float-frames`，记的是浮窗前面那个标签的种类；你说的是（2026-10-10）「如果某个行为设置了浮窗打开，要记得住最后调整的位置跟大小」。恢复默认两样一起清。不进守护进程，不跨设备：它摆的是这台机器上的窗格（0025）。窄屏、手机和平板（托管页）没有窗格，设置里也就没有这一项。/ Per machine, like the layout; only changed choices are stored.

7. **在哪设 / Where it is set.** 设置里单独一个「行为」页签（排在「通用」后面），里面是「窗口打开方式」卡片，这一页签只在桌面工作台开着时出现：每种窗口一行，写着它从哪些入口打开，右边一个下拉，四组选项；改过的标「已改」，卡片头上「恢复默认」。改了下一次打开就生效。/ A Settings tab of its own, Behavior, after General, there only with the workbench; a change applies to the next window opened.

## 实现 / Implementation

`workbench/open-placement.ts` 定义种类、打开方式、默认值和读写；`open-placement-store.svelte.ts` 是设置和工作台共用的一份。`pane-open.ts` 的 `placeNew` 按打开方式放新标签，它要知道的窗口几何（相邻窗格、能不能切、浮窗位置、哪个标签有没保存的编辑）由 `PlaceContext` 从外面给；`ShellWorkbench` 用工作台量到的真实尺寸（`Workbench` 的 `onViewport`）回答。三条打开路径都带上打开方式：`openGuarded`（应用里所有「打开这个」）、选中会话的那个 effect（侧栏、搜索、通知、`?s=`）、新建终端。`openInPane`（「＋」和空窗格）固定放进那一块。

## 没做的 / Not done

- 按入口分别设（例如从通知打开的会话和从侧栏打开的不一样）：先按窗口种类够不够用。/ Per entry point, rather than per kind.
- 按住修饰键临时换一种打开方式（例如 ⌘ 点击开到旁边）。/ A modifier key for a one-off placement.
- 让旧深链也走窗格。/ Routing the legacy deep links through panes.
