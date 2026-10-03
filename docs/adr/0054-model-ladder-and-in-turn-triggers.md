# 你排的模型阶梯，和一轮之内的提档 / The model ladder you order, and stepping up inside a turn

Status: implemented at engine level 7 (`ENGINE_LEVELS.routing`), the rest of issue 27 on top of [ADR 0049](0049-capability-filter-and-escalation.md). Opt-in like the rest of level 7.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §9.2 的阶梯在思考档之后换到 `model_policy.ladder` 里的下一个模型，触发也不只是交付连着没过：同一跳重试后仍是失败形状、工具 JSON 连续两次畸形、同一工具连续失败三次，都该往上走一步。ADR 0049 只做了提思考档，因为模型都没填参考价，应用分不出哪个更强，盲换可能换到更弱的。

ADR 0040 §9.2's ladder moves to the next model of `model_policy.ladder` once the thinking levels run out, and more than failed hand-overs should step a job up: a reply still failing after its retry, tool arguments malformed twice in a row, the same tool failing three times in a row. ADR 0049 only raised the thinking level, because no reference price is set on the models: the app cannot tell which is stronger, and a blind switch could go weaker.

## 决定 / Decisions

1. **阶梯由你排 / You order the ladder.** 设置 → 模型的端点列表下面多一张「模型阶梯」卡（7 级起才有）：从端点名单里挑几个模型，从弱到强排好，最多 8 个，可以上移、下移、拿掉。存在 `settings.model_ladder`（`GET` / `PUT /v1/model-ladder`，手机端同样能改）。每一级必须是端点名单上的模型，不能重复；端点删了或名单里拿掉了某个模型，那一级就从阶梯上去掉，其余的顺序不变。哪个更强只有你说了算，应用不猜。 / Settings → Models gains a Model ladder card under the endpoints (from level 7): pick a few listed models and order them weaker to stronger, at most 8, moved up, down or off. Kept in `settings.model_ladder` (`GET` / `PUT /v1/model-ladder`, the phone included). Each rung must be a listed model, once; a rung whose endpoint goes or stops listing its model leaves the ladder, the rest keeping their order. Only you say which is stronger; the app does not guess.
2. **怎么爬 / How a job climbs.** 每多一步先提一档思考，到模型的顶档为止；测过提档没用（`reasoning_effective = false`）的模型不提档、直接往上爬。思考档用完之后，交付连着没过攒下的每一步是阶梯上往上一级（一轮之内的触发不爬，见 4）：从这一轮本来要用的模型所在那一级往上数，跳过端点不再列出的、以及这件活要看图而标着看不了图的，记 `escalation_model`；新模型的思考档按这条消息的类别取它支持的那一档。爬到最后一级还要往上，就停在最后一级，告诉你一次（「交付接连没过，已经升到头了」）。整张任务通过后复位，回到原来的模型。 / Each step first raises the thinking level, up to the model's top; a model measured to gain nothing from thinking (`reasoning_effective = false`) climbs at once. Once the levels are used up, each step failed hand-overs made is one rung up the ladder (triggers inside a turn do not climb, see 4), counted from the rung of the model the turn would run on, past rungs no endpoint lists any more and, for work that needs pictures, rungs marked as taking none; recorded `escalation_model`, at the thinking level the new model offers for this kind of message. Asking for more past the last rung stays on it, and you are told once. The ticket's approval resets it, back to the original model.
3. **什么不爬 / What does not climb.** 只有应用替 Bot 选的模型（`default`、`endpoint_default`）会沿阶梯换；你钉的模型和任务上指定的模型（[ADR 0049](0049-capability-filter-and-escalation.md) §5）只提思考档，不换。你钉了思考档的 Bot 什么都不动。这轮的模型不在阶梯上时和以前一样：思考档到顶后告诉你一次。 / Only a model the app chose for the Bot (`default`, `endpoint_default`) moves along the ladder; your pin and a ticket's model (ADR 0049 §5) only step up their thinking level, never switched. A Bot whose thinking level you pinned is not moved at all. A turn whose model is not on the ladder works as before: at the top thinking level you are told once.
4. **一轮之内的触发 / Triggers inside a turn.** 除了交付连着没过（ADR 0049），这三种也让这件活往上走一步，记 `model.escalated`（带原因）；两次交付之间最多一步，所以反复出现的同一种麻烦不会自己把台阶越垒越高。它也不打断交付没过的计数。这种台阶只提思考档，不换模型：沿阶梯往上爬只看交付连着没过；思考档本来就到顶时它什么都不动，也不告诉你。 / Besides failed hand-overs (ADR 0049), three more step the job up, recorded `model.escalated` with the reason; at most one such step between two of the job's hand-overs, so trouble that keeps coming back cannot pile steps up on its own. Nor does it start the count of failed hand-overs again. Such a step only raises the thinking level and never switches the model: only failed hand-overs climb the ladder; at the top already it does nothing and tells you nothing.
   - **回复重试后仍失败 / A reply failing after its retry** (`failure_shape`)：复读、拒答、截断、超时、不完整这些模型的失败形状，这一跳重试过一次还是失败、整轮以失败结束时；下一轮按新的一步。 / A loop, refusal, truncation, overrun or incomplete reply that failed again after its retry and ended the turn; the job's next turn runs a step up.
   - **工具参数连续两次不是 JSON / Tool arguments not JSON twice in a row** (`malformed_tool_json`)：空参数不算畸形；中间有一次正常的就重新数。 / Empty arguments are not malformed; a good call in between starts the count again.
   - **同一工具连续三次调错 / The same tool called wrongly three times in a row** (`tool_failures`)：只算模型自己的错——参数不对（`invalid_args`）、被拦下还照调（`refused`，守卫或教训）、该委派却自己调（`use_delegate`）、提到不存在的人（`unknown_mention`）、调一个不存在的工具。文件不存在、超时、MCP 服务报错或限额、叫停拦下、你拒绝批准、重启后重放的调用（`repeated_effect`），换哪个模型都会碰上，不算也不打断。成功一次或换了别的工具就重新数。 / Only the model's own mistakes count: arguments the tool cannot take (`invalid_args`), a call it was refused and made anyway (`refused`, a guard or a lesson), a lead's tool when it should delegate (`use_delegate`), a mention of nobody (`unknown_mention`), a tool that does not exist. A missing file, a timeout, an MCP server's error or quota, a hold, your denial, a call replayed after a restart (`repeated_effect`) can happen to any model: they neither count nor break the count. Success or another tool starts it again.

   后两种在这一轮剩下的跳里就生效：重新按选路规则算一遍，模型不变就换上新的思考档，这一轮的选路记录改成新的档和 `escalation`。一轮中途不换模型。 / The last two take effect for the rest of the turn: routing runs again, and when the model stays the same the remaining hops run at the new thinking level, the turn's route row updated to it with `escalation`. A turn never changes model mid-loop.
5. **记下原本为什么选它 / Why the model was chosen is kept.** 提了档、爬了阶梯或因为看图换了模型的轮次，选路记录除了 `reason_code` 还留着 `base_reason_code`（钉、任务指定、默认……）；流程图上读作「这张任务指定的 · 提了一档思考」。 / A turn stepped up, climbed, or moved for pictures keeps `base_reason_code` (pin, ticket's model, default …) beside its `reason_code`; the trace reads it as "Set on this ticket · one thinking level higher".
6. **不算进默认模型 / Not counted toward the default.** 爬到阶梯上的模型跑的轮次（`escalation_model`），和任务指定模型的轮次（提没提档都一样，看 `base_reason_code`）一样，不算进 Bot 默认模型的推断：那是这件活的，不是这个 Bot 的。 / Turns on a model the job climbed to (`escalation_model`), like turns on a ticket's model (stepped up or not, by `base_reason_code`), do not count toward the Bot's inferred default: that model is about the work, not the Bot.

## 缺口 / Not done

- **另外两种触发**：spec 里「24 小时内同一生产模型被驳回 2 次」和卡片上的「换 X 重做」还没接。前者和交付连着没过大半重合；后者现在用任务上指定模型（ADR 0049 §5）代替。
- **一轮中途换模型**：换模型要等下一轮。中途换会让前面几跳的推理内容和新模型对不上，先不做。
- **按能力自动排阶梯**：阶梯只能你排。`/models` 没有统一的强弱信息可读。

## 取舍 / Trade-offs

- **你排而不是猜。** 应用手里没有可信的强弱信息；你排一次，换来的是有方向的升级。不排的话行为和 ADR 0049 一样。
- **两次交付之间最多一步，只提思考档。** 一轮里工具连着出错可能是同一个原因，连提几档只会更贵，不会更对；换模型更贵，只留给交付确实没过的时候。
- **到顶只说一次。** 每个 Bot 每个模型只告诉你一次（ADR 0049 的做法），之后同一个模型再到顶不再说；能看到的是流程图上的原因。
- **只从应用选的模型往上爬。** 钉和任务指定是你的明确选择；替你换掉会让「钉」失去意义。
