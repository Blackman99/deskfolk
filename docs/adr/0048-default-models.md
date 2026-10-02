# 默认模型代替每轮选路 / Default models instead of a per-turn pick

Status: implemented at engine level 7 (`ENGINE_LEVELS.routing`), the first part of ADR 0040's P5. Experimental and opt-in like levels 5 and 6 (`engine-level.ts --accept-older-app`, or `--level 7`); a build never raises a data folder past level 4 on its own.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §9 要让「这一轮跑在哪个模型上」变成几条固定规则，不再每轮开头调一次模型来挑。审计（§4.3）里，开轮前的选路平均挡 11.5 秒、一天累计 22.7 分钟，约 65% 的理由是「沿用」；[ADR 0037](0037-cut-the-core-loop-by-the-benchmark.md) 关掉它之后，solo 的花费从 $0.89 降到 $0.40、用时从 11 分 23 秒降到 2 分 01 秒。可是直接删掉选路也不行：视频导演、审片员、编剧分镜师都没钉模型，会全部落到端点默认，也就是那几次 128K 复读都出自的那个模型。所以先给每个 Bot 定一个默认模型。

ADR 0040 §9 wants what a turn runs on to be a few fixed rules, not a model call before every turn. In the audit (§4.3) that pick held each turn up 11.5 seconds on average, 22.7 minutes in a day, and about 65% of its reasons were "same as before"; with it off ([ADR 0037](0037-cut-the-core-loop-by-the-benchmark.md)) a solo run went from $0.89 to $0.40 and from 11m23s to 2m01s. Deleting it outright would not do either: 视频导演, 审片员 and 编剧分镜师 pinned nothing and would all fall to the endpoint's default — the model all three 128K repetition loops came from. So each Bot gets a default model first.

## 决定 / Decisions

1. **版本边界 / Version boundary.** `ENGINE_LEVELS.routing = 7`。新加的只是几列（`bots.default_*`、`turn_route_decisions.reason_code`），更早的二进制打开 7 级的库只会照旧每轮选路，不会读错，所以 7 级不抬兼容地板（`FLOOR_AT_LEVEL[7] = 6`），`SCHEMA_LEVEL` 仍是 6。 / Level 7 only adds columns (`bots.default_*`, `turn_route_decisions.reason_code`); an older binary opening a level-7 database just goes on picking per turn and misreads nothing, so level 7 leaves the floor at 6 and `SCHEMA_LEVEL` stays 6.
2. **决策顺序 / The order.** 你钉的模型 → Bot 的默认模型 → 端点默认（`engine/routing.ts` 的 `decideRoute`，纯代码，不调模型）；每轮在 `turn_route_decisions.reason_code` 记 `pin`、`default`、`endpoint_default` 或 `pin_unlisted`。思考档用钉的（或默认里记的）那一档，这个模型现在的档位表里没有、或者没钉档时，按这条消息的类别取它支持的最近一档。只钉了端点没钉模型的 Bot，默认的推断和端点默认都只在那个端点的名单里找。钉的模型已经不在任何端点名单上时，先用端点默认（`pin_unlisted`），不在你的钉后面推断默认，并在你和它说话的地方告诉你一次。 / Your pin → the Bot's default → the endpoint's default (`decideRoute` in `engine/routing.ts`, code only, no model call); each turn records `pin`, `default`, `endpoint_default` or `pin_unlisted` in `turn_route_decisions.reason_code`. The thinking level is the pinned (or the default's) one; when the model's level list no longer has it, or none is pinned, the nearest level it offers for this kind of message is used. A Bot pinned to an endpoint but no model has its default inferred, and its fallback taken, from that endpoint's list only. A pin no endpoint lists any more runs on the endpoint's default (`pin_unlisted`), never on a default inferred behind your pin, and you are told once where you and the Bot talk.
3. **默认怎么来 / Where a default comes from.** 第一次要用时推断：这个 Bot 最近 7 天的选路记录里，端点名单上还在的模型中跑得最多的那个，思考档取它在这个模型上最常用的一档（`store/model-defaults.ts`）。推断的同时在你和它的私聊里（没有私聊就在你们最近同在的会话里）出一张卡片［就用这个］［用端点默认］；你回答之前就用推断的——这正是旧的每轮选路最常落到的。确认记 `confirmed`；拒绝清掉默认、记 `declined`，以后不再推断。一周里没有用量可推断的 Bot 没有默认，用端点默认。 / Inferred the first time it is needed: among the models the endpoints still list, what the Bot ran on most in its route records of the last 7 days, at the thinking level it ran that model on most (`store/model-defaults.ts`). A card in your direct with it (else the conversation you last shared) puts it to you [Keep it] [Use the endpoint's default], and until you answer the inferred one is used — it is what the old per-turn pick settled on most. Kept, it is `confirmed`; declined, it is cleared and `declined`, and nothing is inferred again. A Bot with no use to go on has no default and runs on the endpoint's.

## 缺口 / Not done

- **能力过滤和升级阶梯**（§9.1、§9.2）：需要看图时只挑能看图的模型、同一件活连续失败时提档或换模型，还没做；模型条目还没有能力字段。
- **复盘与学习**（§9.3、ADR 0035）照旧运行；选路规则（`decideTurnRoute`）和每轮选路的代码在 7 级以下仍在用，等 P6 收缩时删。
- 流程图卡片上的路由信息（ADR 0026）还没换成 `reason_code`。

## 取舍 / Trade-offs

- **推断后先用、再问你。** 先问再用会让所有没钉的 Bot 在你回答前落到端点默认；先用推断的，最坏也就是延续过去一周的选择。
- **按轮数推断，不按质量。** 质量信号要等 P5 后半段把反馈接到交付上；现在能确定的只有它实际跑在什么上。
