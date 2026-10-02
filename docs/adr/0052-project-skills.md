# 项目技能：你把一个 Bot 的技能共享给所有 Bot / Project skills

Status: implemented at engine level 8 (`ENGINE_LEVELS.learning`), with [ADR 0050](0050-quality-events-and-lessons.md) and [ADR 0051](0051-narrowed-reflection.md); the last part of issue 28. The quality report gets its view here too.

[ADR 0040](0040-agent-kernel-the-job-owns-state.md) §7.6：工序模板和审查清单该升为项目级技能，按角色共享；从某个 Bot 的私有技能升级要你确认（[ADR 0021](0021-per-bot-memory.md) 的隐私顾虑）。审片员自己写的「镜头交界连贯性审查」就该升到这一级，出片的 Bot 在生成前也能看到。

ADR 0040 §7.6: procedures and review checklists should become project skills; promoting one of a Bot's own skills takes your confirmation (ADR 0021's privacy concern). The reviewer's own "cut continuity review" belongs there, so the producer reads it before generating.

## 决定 / Decisions

1. **共享是你的事 / Sharing is yours.** Bot 的资料页「技能」里多一张「项目共享技能」卡（8 级起才有）：这个 Bot 的每条技能旁边是「共享给所有 Bot」，按下再确认一次（所有 Bot 会看到全文）。Bot 没有共享技能的工具。 / A Bot's Skills tab gains a Project skills card (from level 8): each of its skills offers "Share with every Bot", confirmed by a second press (every Bot will see all of it). No Bot has a tool to share.
2. **共享的是副本 / A copy is shared.** `shared_skills` 存的是共享那一刻的名称、说明、正文和依赖的 MCP。原 Bot 之后再改，别的 Bot 读到的不变，卡片上标「共享后又改过」；按「更新共享副本」先把现在的正文给你看，再按「确认更新」才换成新的——技能里可能写进了 Bot 记下的关于你的事，后来的改动要你再看一次。 / `shared_skills` keeps the name, description, body and MCP list as they were when you shared. The owner's later edits leave what others read unchanged; the card marks it "changed since shared"; "Update the shared copy" first shows you the body as it is now, and only "Update it" takes it — a skill can come to hold what the Bot noted about you, so a later change is yours to read again.
3. **怎么读 / How it is read.** 每个 Bot 的技能目录里，项目技能和它自己的列在一起，标「项目共享，来自 X」；`read_skill` 按名字读得到，但不是它的，`update_skill` / `delete_skill` 改不了。一个 Bot 自己有同名、启用着的技能时，用它自己的（停用的不挡）。项目技能的名字在项目里唯一：另一个 Bot 的同名技能共享不了；同时最多开 20 条，每条都在每个 Bot 的 system 里。你可以在原 Bot 的卡上或别的 Bot 的卡上停用（所有 Bot 都不再看到）、再启用，或停止共享（副本删掉，原技能不动）。原 Bot 删掉后，它的副本照样共享着，标「来自已删除的 Bot」，要收回就停止共享；已删除的 Bot 的技能不能再共享。 / Each Bot's catalog lists project skills beside its own, marked "project skill, from X"; `read_skill` reads one by name, but it is not the Bot's, and `update_skill` / `delete_skill` cannot touch it. A Bot with an enabled skill of its own by the same name uses its own (a turned-off one does not stand in front). A project skill's name is unique in the project: another Bot's skill of that name cannot be shared; at most 20 are on at once, as each is in every Bot's system prompt. You can turn one off on its owner's card or another Bot's (no Bot sees it), back on, or stop sharing it (the copy goes, the original stays). A deleted owner's copies stay shared, marked as from a deleted Bot, until you stop sharing them; a deleted Bot's skills cannot be shared.
4. **报表的界面 / The report's view.** 花费页底部多一张「质量（近 7 天）」表，读 `GET /v1/quality/report`：每行一个 Bot × 模型 × 规划类型，交付、通过、打回（审查 · 你 · 检查）、投诉、回复失败、误放行、每次通过的花费。没有可报的时不出现，8 级以下也不出现（打回、投诉、误放行只从 8 级起记，0 会被当成真数）；刚升到 8 级的那一周，这几列还在攒。它只读：要改，钉一个模型。 / The spend page gains a "Quality, last 7 days" table at the bottom, reading `GET /v1/quality/report`: one row per Bot × model × plan kind with hand-overs, approvals, turn-backs (by a reviewer · by you · by checks), complaints, failed replies, review misses and the spend per approval. It is not shown when there is nothing to report, nor below level 8 (turn-backs, complaints and misses are filed from level 8 only, and zeros would read as counts); for the first week at level 8 those columns are still filling. It only reads: to act on it, pin a model.

## 缺口 / Not done

- **按角色共享**：没有 `bots.role`，项目技能给所有 Bot；按角色收窄要等角色有了再说。
- **由反思提议共享**：ADR 0051 的反思只提清单和检查，不提「把这条技能共享出去」。

## 取舍 / Trade-offs

- **副本而不是引用**：多一个「更新共享副本」的按钮，换来原 Bot 后来写进去的东西不会自己流到别的 Bot 那里。
