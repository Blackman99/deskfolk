# 每日花费上限 / A daily spend cap

Status: implemented 2026-10-12. Takes up what [ADR 0027](0027-spend-ledger-and-view.md) left out of scope (budgets, daily limits, automatic stops); builds on the holds of [ADR 0040](0040-agent-kernel-the-job-owns-state.md) and keeps [ADR 0081](0081-a-stop-is-just-a-stop.md) for your own stops.

## 背景 / Context

2026-10-12 的一次评审从普通用户的角度看「什么会让人开始用、什么会让人走」，其中一条是：这个应用叫你交出去、离开，可你走开时花多少钱没有上限。读句每句话读一次，整理器、书记员、复盘和几个 Bot 都在你的 key 上跑，花费视图写着「不设预算或自动停机」。你说：「按照你的推荐改」。

A review on 2026-10-12 of what makes an ordinary user start or leave found, among others: the app tells you to hand work off and walk away, yet nothing caps what it spends while you are gone. Every line is read once, the organizer, the scribe, the retrospective and several Bots all run on your key, and the spend view said it set no budget or automatic stop. You said: "change it as you recommend."

## 决定 / Decisions

1. **一个按天的美元数 / One USD amount per day.** 设置里多一个 `spend_cap_usd`（正数或 null，存到分），在花费视图「概览」最上面填，桌面和手机同一张卡片，经中继也能改。从运行守护进程那台电脑的本地零点起，每次调用按 `COALESCE(实报, 估算)` 加起来；两样都没有的不算。本机 Agent 跑的按它报的估算价算，哪怕花的是订阅额度：上限管的是「这台电脑今天跑了多少」，订阅额度也是额度。默认不设。 / Settings gain `spend_cap_usd` (a positive number or null, kept to the cent), entered at the top of the spend view's Overview — one card on desktop and phone, and settable over the relay. From local midnight on the computer that runs the daemon, each call adds its reported cost, else its estimate; a call with neither adds nothing. A local agent's runs count at the price it estimates even on a subscription: the cap is about how much this computer ran today, and a plan's usage is usage too. None by default.

2. **到了就停下所有 Bot，用应用自己的一条叫停 / Reaching it stops every Bot, by a stop of the app's own.** 调度器每 15 秒一拍，最先看上限（在监督器、日程和回看之前，免得这一拍又叫醒谁）。到了就建一条 `scope: global`、`source: spend_cap`、`lift_on_next_user_message: false` 的叫停，走和「停下所有 Bot」同一条路（`carryOut`）：正在跑的轮次当场结束，被它停下的活记在叫停上，日程、回看、监督器的叫回和 Bot 之间的话都被挡住。不发回执：它不属于哪条会话。叫停的 `effect.spend_cap` 记下当时的上限和今天已花多少。 / The scheduler's 15-second tick looks at the cap first, before the supervisor, routines and check-backs, so the same tick wakes no one. Once it is reached, a hold with `scope: global`, `source: spend_cap` and `lift_on_next_user_message: false` is made the way "Stop every Bot" is (`carryOut`): live turns end at once with what they were doing recorded on the hold, and routines, check-backs, call-backs and Bots' lines to each other are held. No receipt: it belongs to no conversation. The hold's `effect.spend_cap` keeps the cap and what the day had cost.

3. **只有你的「解除」能放开 / Only your Lift ends it.** ADR 0081 让你的叫停随你下一句话结束；这条不是你的，是应用替你花钱把的关，和应用自己搁置的规划一样等你解除。它列在侧栏「叫停中」里，写「今日花费到上限 $Y」（侧栏一行放得下的长度；今天实际花了多少记在叫停上），带「解除」。你对 Bot 说话，它只能只读地回答；「所有 Bot 继续」也不解除它。 / ADR 0081 ends your stops with your next line; this one is not yours but the app keeping your money, and like the app's own parked plans it waits for you. It is listed under Stopped in the sidebar — "Daily cap $Y reached", short enough for the sidebar's row; what the day had cost is kept on the hold — with a Lift. A line to a Bot gets a read-only answer, and "every Bot go on" does not lift it.

4. **一天、一个上限，只拦一次 / Once per day per cap.** 拦过之后在设置里记下哪天、按哪个上限拦的（`spend_cap_trip`）。解除之后当天不再拦，否则下一拍立刻又停；改了上限（高或低）按新数重算，过了零点也重算。已有一条在生效时不再建第二条。 / Once it has stopped the Bots, the day and the cap are recorded (`spend_cap_trip`). After a Lift it stops nothing more that day — else the next tick would stop them again — while a new cap, higher or lower, or the next midnight counts afresh. With one already in force no second is made.

5. **表要重建一次 / The table is rebuilt once.** `holds.source` 是 SQLite 改不了的 CHECK，旧表照 `migrateAgentRunners` 的做法重建一次（定义加上 `spend_cap`、逐行拷贝、索引和触发器原样再建、`held_scopes` 视图按名字读不用动）。旧版本读到这条叫停照样遵守，只是不列出来。 / `holds.source` is a CHECK SQLite cannot widen, so an older table is rebuilt once the way `migrateAgentRunners` does it (the definition with `spend_cap` added, rows copied, indexes and triggers made again; the `held_scopes` view reads it by name and stays). An older build honours such a hold and lists it nowhere.

## 取舍 / Trade-offs

- **最多晚 15 秒 / Up to 15 seconds late.** 不在每次记花费时就判，花费写入保持只写；这 15 秒里正在跑的那一跳还会再花一点。 / It is not judged as each call is recorded, which keeps spend write-only; a hop already running spends a little more meanwhile.
- **没有提醒 / No warning first.** 到了才停，之前不发通知；也没有横幅：等你回来时侧栏那一条说明了一切。 / It stops when reached, with no notice before it and no banner: the sidebar line says it when you come back.
- **订阅也算钱 / Subscriptions count as money.** 用 Claude Code、Codex 订阅的人设了上限，会按估算价被拦；不想要就不设。 / Someone on a Claude Code or Codex plan with a cap set is stopped at the estimated price; leave it unset to avoid that.
- **不做的 / Not done.** 按会话、按 Bot、按一件事的上限，到之前的提醒，调高上限时自动解除，MCP 工具另收的钱。 / Caps per conversation, per Bot or per job; a warning before it is reached; lifting it when you raise the cap; what MCP tools bill on their own.

## 实现 / Implementation

`store/spend-cap.ts`（上限的读写、本地零点、今天已花、`spendCapDue`、`noteSpendCapTrip`）、`store/hold-source-migration.ts`、`engine/stop/carry-out.ts` 的 `holdForSpendCap`、`engine/spend-cap.ts` 的 `createSpendCapWatch`、`turn-engine.ts` 的 `capSpend`、`scheduler.ts` 每拍先调它；`remote/routes.ts` 的设置白名单加 `spend_cap_usd`。信使：`spend/SpendCap.svelte`（概览最上面的卡片）、`sidebar/holds-list.ts` 把 `spend_cap` 列进「叫停中」并写出金额。
