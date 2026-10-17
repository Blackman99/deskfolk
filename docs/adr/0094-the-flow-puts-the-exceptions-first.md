# 流程图先说例外 / The flow puts the exceptions first

Status: implemented 2026-10-17. Changes what a job's flow draws by default; its shape (dagre, rounds stacked down one spine, [ADR 0086](0086-a-job-is-one-tab.md)) is unchanged. Amends [ADR 0083](0083-flow-draws-the-apps-calls.md) (the steps are drawn only where one went wrong, until you ask for all).

## 背景 / Context

你说（2026-10-17）：「当前的流程图还是不太好，从信息角度已经非常丰富了，就是不太让人一眼抓中重点。」拿本机上的《明天见》（104 轮、374 个环节）量了一遍，问题不在少了什么，而在每样东西画得一样重：

- 104 张卡里 97 张是绿色的「完成」，绿色成了底色；3 张中断、4 张停下和 8 个异常环节，和别的卡一样大、一样醒目。
- 卡上一半是不变的行：模型行 87 张里有 85 张和这个 Bot 的上一张相同；「与视频导演 ↔ 审核员的私聊」写在 56 张卡上；任务号有 59/90 张和唤醒它的卡相同。卡高 95–238px，多半是这些行撑的。
- 应用自己的调用比 Bot 干的活还多：374 个环节对 104 轮，其中 305 个是「读 Bot 的话」，说的多是「还在做」，画得和卡差不多大，夹在两侧。
- 打开时缩到 60%（工作台默认的侧边窗格只有约 515px），12px 的正文实际约 7px；32 行折叠的轮次只写「N 张卡 · N 个文件」。

只用样式在同一件事上模拟了改后的样子：卡高 62–132px，同一块地方放得下的卡从约 3 张变成约 9 张，全图只剩那张中断的卡有颜色。

You said (2026-10-17): "The flow still isn't right. It is very rich in information, it just doesn't let you catch what matters at a glance." Measured on this Mac's 《明天见》 job (104 turns, 374 steps), nothing was missing; everything was drawn at the same weight:

- 97 of 104 cards were a green "Done", so green was the ground; the 3 cut and 4 stopped turns and 8 steps that went wrong were as large and as loud as the rest.
- Half of a card was lines that never changed: the model line on 85 of 87 cards matched the same Bot's previous card; "Direct with 视频导演 ↔ 审核员" was on 56 cards; the ticket number matched the waking card's on 59 of 90. Cards were 95–238px tall mostly for these.
- The app's own calls outnumbered the work: 374 steps to 104 turns, 305 of them readings of a Bot's words that mostly said "still at it", drawn nearly a card's size on both sides of the chain.
- The board opened at 60% (the workbench's default side pane is about 515px), where 12px text is about 7px; the 32 folded rounds said only "N cards · N files".

A styles-only mock of the change on the same job: cards 62–132px, about nine in the space that held three, and the cut card the only coloured one on the board.

## 决定 / Decisions

1. **只给例外上色 / Colour only the exceptions.** 做完的那一轮不上底色、不描绿边、不写「完成」，左边那条是线的灰；颜色只留给还在做的（青）、等你的（黄、紫）、中断和停下的（红），以及你的决定。角落小地图里做完的也不再是绿的。「你在这里」那圈青色仍然不画在做完的卡上，否则这件事自己会话里的卡又全成了青色。配色本身不变。/ A finished turn has no fill, no green edge and no "Done"; its stripe is the line's grey. Colour is left to turns still going (teal), waiting on you (yellow, purple), cut or stopped (red), and your decisions. The minimap's finished marks lose their green too. The teal "you are here" ring still skips finished cards, or the job's own conversation would turn teal instead. The palette is unchanged.

2. **重复的行不重复画 / Say it once.** 模型行和这个 Bot 在板上的上一张卡（端点、模型、思考档、消息类型都相同）一样时，只在第一行右端写一个小小的模型名，点开还是同样的详情（这枚小标签在卡片按钮之外，不是套在里面）；这个 Bot 的第一张、换了的、有你的反馈、审查归咎模型或失败的，照旧整行。任务号只在和唤醒它的卡不同时写；「…的私聊」只在从唤醒它的卡换了会话时写，一段来回只在第一张上。摘要最多两行，全文在鼠标提示里，也在卡跳到的那条消息里。/ A model line that matches the same Bot's previous card on the board (endpoint, model, thinking and kind of message) becomes a small model name at the first line's right end, opening the same details (the chip sits beside the card's button, not inside it); a Bot's first card, a change, or one with your pushback, a review blaming the model or a failure keeps the whole line. The ticket number shows only where it differs from the waking card's, and the place only where the conversation changed from the waking card's, so a back and forth names its direct once. A summary stops at two lines, the rest in its tooltip and in the message the card jumps to.

3. **环节默认只留异常的 / Only the steps that went wrong, by default.** 一件事的流程平时只画没成或说「不」的环节；没画的环节下面挂着的，挂到上面最近一个还画着的环节或卡上。「显示全部环节」画出全部（读句、归属都在里面，[ADR 0089](0089-filing-is-seen-in-the-flow.md) 说的「只在流程里看」仍然一按就到），按浏览器记住，用新的存储键，让以前按过「显示」的浏览器也换到新的默认；「环节有异常 N」两种时候都在。一句话自己的流程只有你那张卡和它的环节，总是画全，没有这个切换。/ A job's flow draws only the steps that did not work or said no; what hung from a step left out hangs from the nearest step or card above it still drawn. "Show all steps" draws them all (the reading and filing among them, so ADR 0089's "seen in the flow" is still one press away), kept per browser under a new storage key so that browsers that had pressed "Show" start from the new default; "Steps that went wrong N" is there either way. A line's own board is your card and its steps, so it always draws them all and has no switch.

4. **折叠的轮次写做到了哪 / A folded round says where it got to.** 折叠行第二行是这一段最新那张卡的 Bot 和它说的话，后面跟几轮没做完、几个文件、几个环节有异常；卡片数挪进鼠标提示。展开的那一段的标题行不变。/ A folded line's second row is the newest card's Bot and what it said, then turns cut short, files and steps that went wrong; the card count moves to the tooltip. An open round's line is unchanged.

5. **打开时至少 80% / Open at 80% at least.** 能读的下限从 60% 提到 80%（正文约 10px）。只管打开时的视角：放得下就整张，放不下就停在最新的一段、主干居中，两侧分支可能出画面，要拖一下。/ The readable floor goes from 60% to 80% (text about 10px). It governs only the opening view: the whole board when it fits, else the newest round with the spine centred, side branches possibly off screen.

## 后果 / Consequences

- **按缩放换画法推迟 / Semantic zoom deferred.** 缩小时普通卡缩成一行、只有关键卡保留整卡，要按 dagre 量出来的盒子重新排，不是样式能做的；等这一轮用一阵再定。/ Collapsing ordinary cards to one line below some zoom means re-laying out from dagre's measured boxes, not a style; decided after this round has been used for a while.
- **「带文件」不算重点 / Files are not a landmark.** 《明天见》里 31 张卡带文件、一共 736 个，多是中间版本；文件照旧画在卡上，不因此上色。/ On 《明天见》 31 cards carry 736 files, mostly intermediate versions; files stay on their cards and colour nothing.
- **结构不变 / The shape is unchanged.** 只改画什么、画多重；轮次、主干、dagre、整张泳道不做（ADR 0086）都照旧。/ Only what is drawn and how loud changed; rounds, the spine, dagre and no full swimlane (ADR 0086) stand.
