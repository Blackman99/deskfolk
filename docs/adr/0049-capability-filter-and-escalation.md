# 按能力挑模型、失败时提档 / Picking by capability, and stepping up on failure

Status: implemented at engine level 7 (`ENGINE_LEVELS.routing`), the second part of ADR 0040's P5, on top of [ADR 0048](0048-default-models.md). Opt-in like the rest of level 7.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §9.1 和 §9.2 要让「这件活需要看图」和「这件活一直没过」直接影响它跑在什么上，而不是靠每轮一次的模型挑选去猜。ADR 0048 定下默认模型之后，剩下两件：能力不够的模型别接需要看图的活；同一件活连着失败时，按固定规则往上走一步。

ADR 0040 §9.1 and §9.2 want "this work needs pictures seen" and "this work keeps failing" to change what it runs on directly, not by a per-turn model pick guessing. With ADR 0048's default models in place, two things are left: a model that cannot see pictures should not take work that needs them, and a job that keeps failing steps up by a fixed rule.

## 决定 / Decisions

1. **能力写在模型条目上 / Capability lives on the model entry.** 模型条目多一项 `input_image`：能看图、看不了图，或者没写（不确定）；在端点设置里每个模型的「看图」一栏改，保存表单时不发这一项就保留原值，选「不确定」就清掉。没写的按能看图对待——不确定的不挡路。 / Model entries gain `input_image`: takes pictures, takes none, or unset (not known); set per model under "Pictures" in the endpoint settings, kept when a save leaves it out, cleared by "Not sure". Unset counts as able: not knowing never blocks.
2. **哪些活需要看图 / Which work needs pictures.** 开这一轮的那句话带着图片，或者这个 Bot 是任务的审查者、而任务有关于画面的必查要求（[ADR 0046](0046-submissions-and-reviews.md)）。 / The line that opened the turn carries a picture, or the Bot reviews a ticket with a requirement about the picture (ADR 0046).
3. **按能力过滤 / The filter.** 需要看图、而选出来的模型标着看不了图时：钉的模型照用（你的钉优先，提了档也一样），在你和它说话的地方告诉你一次；否则换成名单上标着能看图的模型（没有就换一个没标看不了的），只钉了端点的只在那个端点里找，记 `capability_filter`；一个都没有就照用并告诉你一次。一轮中途 `read_file` 读到图片、而这一轮的模型标着看不了图时，不把图发给它，工具结果写明它看不了这张图。 / When work needs pictures and the model picked is marked as taking none: a pin stays (yours comes first, stepped up or not) and you are told once; otherwise it moves to a listed model marked as taking pictures (else one not marked as taking none), within the endpoint when only an endpoint is pinned, recorded `capability_filter`; with none at all it stays and you are told once. A picture `read_file` reads mid-turn is not sent to a model marked as taking none; the tool result says so.
4. **升级阶梯，故意做短 / The escalation ladder, kept short on purpose.** 一件活（工作项）自上次提档以来连着 2 次交付没过（检查没过、审查打回、你在卡片上退回；中间有一次通过就重新数；整理跳认为做完了、被你退回的那种不算，那不是它交的），就往上一步：这件活跑高一档思考，最多到模型支持的顶档；整张任务通过后复位（`work_items.escalation`），只过了其中一个分件不复位。不自动换模型——模型的参考价都没填，看不出哪个更强，盲换可能换到更弱的——到顶了在你和它说话的地方告诉你一次，换不换由你钉。你钉了思考档的不提；测过「提档没用」（`reasoning_effective = false`）的模型也不提。 / A job (work item) whose hand-overs failed twice in a row since its last step (checks, a review's reject, your send-back; an approval in between starts the count again; your send-back of the organizer's reading does not count, since the Bot did not hand that over) steps up one thinking level, up to the top its model offers; the ticket's approval resets it (`work_items.escalation`), not one part's. It never switches models on its own — no reference price is set on the models, so there is no telling which is stronger, and a blind switch could go weaker — so at the top you are told once, and switching is yours to pin. A thinking level you pinned is never raised, nor on a model measured to gain nothing from it (`reasoning_effective = false`).

## 缺口 / Not done

- **换模型那一级**：spec 的阶梯在思考档之后换到 `model_policy.ladder` 里的下一个模型；没有排好的阶梯，这里只提档。
- **其他触发**：同一跳重试后仍是失败形状、工具 JSON 连着畸形、同一工具连败三次，还没接到阶梯上。
- **能力探测**：`input_image` 只能手填；`/models` 没有统一的字段可读。

## 取舍 / Trade-offs

- **不确定当能。** 当成不能会让还没填的名单在第一张图上全军覆没；看不了图的模型收到图时端点会报错，那一轮照常按失败处理。
- **钉住的不动。** 钉了看不了图的模型去审画面，是你的选择；告诉你一次，不替你改。
