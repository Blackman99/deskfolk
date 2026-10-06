# Bot 能查本机记录：分析、改进有依据 / Bots read this machine's records, for the evidence behind an improvement

Status: implemented 2026-10-06, at no engine level. It amends [ADR 0021](0021-per-bot-memory.md) (another Bot's memories can now be read, never injected) and the CONTEXT entry on the organizer run log (no longer "not for Bots").

你说的是（2026-10-06）：「系统所有的落地数据都支持 Bot 进行查看，Bot 可以根据已有的数据分析行为进行自优化或者系统层优化。」在这之前，Bot 只看得到自己这一轮的上下文窗：最近一段转录、局面块、自己的记忆。想回答「上周哪类活总被退回」「整理跳最近为什么老读不懂」，它要么凭印象，要么用越界的 shell 去开 `state.sqlite`——那要你批准，而且库里混着远程访问的推送密钥、设备公钥和你自己终端的滚动缓冲。

You put it this way (2026-10-06): every record the system keeps should be readable by Bots, so a Bot can analyze how work went and improve itself or the system. Until now a Bot saw only its own turn's window — a stretch of transcript, the situation block, its memories. To answer "which work keeps being sent back" or "why does the organizer keep failing to read" it either guessed or opened `state.sqlite` with an unconstrained shell, which needs your approval and reaches a database that also holds remote access's push secrets, device keys and your own terminals' scrollback.

## 决定 / Decisions

1. **三个只读工具 / Three read-only tools.** `describe_data` 列出表、列、行数，主要的表附一句说明（`data-query/catalog.ts`）；`query_data` 在本机记录上跑一条只读的 SQLite 查询（单条 SELECT 或 WITH … SELECT，参数按 `?` 绑定，默认 100 行、上限 1000，长格子截断，二进制只给字节数）；`read_data_log` 读守护进程日志的末尾（`daemon.log`、开发版的 `daemon-dev.stderr.log`），可以 grep。三者都没有副作用：叫停中、只读段里也能用，不出批准卡——它们读的是应用自己的记录，由应用把关，不是越界读文件。Claude Agent 跑的 Bot 也经 `mcp__deskfolk__` 拿到它们。/ `describe_data` lists tables, columns, row counts and a line on the main ones; `query_data` runs one read-only SQLite query (a single SELECT or WITH … SELECT, `?` bound in order, 100 rows by default and 1000 at most, long cells cut, blobs shown by size); `read_data_log` reads the end of the daemon's logs, with grep. None has a side effect: they work under a hold and in read-only segments, and raise no approval card — they read the app's own records through the app, not files outside the workspace. Claude Agent Bots get them under `mcp__deskfolk__` too.

2. **只读，在子进程里跑 / Read-only, in a child process.** SQLite 的查询是同步的，Bun 也没有办法中途打断它：放在守护进程里跑，一条大查询就会卡住所有的轮。所以查询在守护进程自己再起的一个子进程里跑（`--query-data`，编译版只有一个文件，带不了别的脚本），用只读连接加 `PRAGMA query_only` 打开库，10 秒没答完就杀掉，同时最多两个。/ A SQLite query is synchronous and Bun cannot interrupt it; run in the daemon, one heavy query would stall every turn. So it runs in a child the daemon starts from itself (`--query-data`; the compiled binary is one file), on a read-only `query_only` connection, killed at 10 seconds, two at most at once.

3. **拦什么，怎么拦 / What is refused, and how.** 拒绝名单是表：`remote_*`（推送订阅的密钥和端点、设备公钥、配对）、`pending_keys` 和 `request_receipts`（远程凭据操作的回执，存着请求体和响应头）、`notification_push_config` 和 `notification_devices`（远程推送的配置和接收方，没有行为信号）、`terminals`（你的终端滚动缓冲；产品规则是 Bot 不知道终端存在）、`sqlite_*`。拦两层：先看字（只许一条只读语句，不许 ATTACH、PRAGMA、写语句、`load_extension` 这类函数和 `pragma_*`、`dbstat`、`bytecode` 这类表函数，点了名单上的表就是「no such table」，不透露它存在）；再看查询计划（`EXPLAIN` 里每个打开的游标按根页对回表，经视图或索引碰到名单上的表、打开别的库、扫了 `json_each` / `json_tree` 以外的虚表、或有写操作的，都拒；虚表按它在这条连接上的实例认，换个名字叫也认得出）。端点和 MCP 的密钥本来就在钥匙串里，库里只有引用；一条测试用带探针的密钥走一遍批准卡，再扫每张放行表的每一列，确认没有落进去。/ The denied tables: `remote_*`, `pending_keys` and `request_receipts`, `notification_push_config` and `notification_devices`, `terminals`, `sqlite_*`. Two layers: the words (one read-only statement; no ATTACH, PRAGMA, writes, extension or file functions, `pragma_*`, `dbstat` or `bytecode`; a denied table reads as "no such table") and the query plan (each cursor `EXPLAIN` opens is traced by root page to its table; a denied table reached through a view or an index, another database, a virtual table other than `json_each` / `json_tree` — known by its instance on the connection, whatever the query calls it — or any write is refused). Endpoint and MCP keys live in the keychain, with only a reference in the database; a test pastes canary keys on approval cards and scans every column of every readable table for them.

4. **数据目录只读两份日志 / Of the data folder, only the logs.** 读日志只认 `daemon.log`、`daemon-dev.stderr.log` 和它滚动的 `.1`；不跟软链；本机 token 的 `local-api.json`、远程凭据、库的备份都读不到。读出来的行里像密钥的（`Bearer …`、`sk-…`、`api_key=`、`token=`、`Authorization:`）先抹掉，再按 grep 筛，免得一串 grep 逐字试出一个密钥。/ Only `daemon.log`, `daemon-dev.stderr.log` and its `.1`; no symlinks; never `local-api.json`, remote credentials or database backups. Anything that looks like a key is blanked out before the grep runs, so a run of greps cannot spell one out.

5. **修订 ADR 0021 / This amends ADR 0021.** 记忆仍然只进它自己那个 Bot 的上下文，别的 Bot 也写不了它；但别的 Bot 现在能经本机记录读到它。不把别人的记忆抄成自己的，除非你要。同样，「整理跳的运行记录」以前写明不给 Bot 看，现在能查（仍然不进手机的白名单）。/ A memory still enters only its own Bot's context and no other Bot writes it; another Bot can now read it through the records, and copies it into its own only if you ask. The organizer run log, once "not for Bots", can be queried too (still not on the phone's whitelist).

6. **只在你开口时 / Only when you ask.** 系统指令写明：要依据时用这三个工具，查不到的就是不给 Bot 看的；只在你要它分析、改进时才做。它拿到的依据用来提改动——自己的做法改进自己的技能和记忆，每个 Bot 都该照做的走 ADR 0064 的批准卡改内置提示词。/ The System section says: use these for evidence; what you cannot find is not for Bots; only when the user asks for analysis or improvement. The evidence feeds proposals — a Bot's own ways into its skills and memories, what every Bot should do into a built-in prompt through ADR 0064's approval card.

## 缺口 / Not done

- 手机上不能查；也不能读两份日志以外的文件（工作区里的文件本来就能读）。/ Not from the phone; no file besides the two logs (workspace files were always readable).
- 没有预先算好的分析视图（返工率、读不懂率）：现在由 Bot 自己写 SQL。/ No ready-made analysis views (rework rates, unreadable rates): Bots write the SQL.

## 取舍 / Trade-offs

- **Bot 能读到的变多了**：别的 Bot 的私聊、它们的记忆，以及你在聊天里贴过的任何东西（包括你不该贴的密钥）。这是你要的「所有落地数据」；密钥这类东西该走批准卡，而不是贴进聊天。/ Bots now read more: other Bots' directs and memories, and anything you ever pasted into a chat, keys included. That is what "every record" means; keys belong on approval cards, not in chat.
- **大结果会落进工作区**：超过 8000 字的工具结果照旧存进这一轮工作目录的 `tool-results/`。默认行数小、提示词里要它在 SQL 里先聚合，是为了少落盘。/ Large results land in the workspace: a tool result over 8000 characters is saved under the turn's `tool-results/` as before; small defaults and aggregating in SQL keep that rare.
- **每次查询多花 0.1–0.3 秒**：子进程要先加载守护进程的模块。/ Each query costs 0.1–0.3 s more: the child loads the daemon's modules first.
- **按表名拦**：一张以后新加的表若存了密钥，要记得加进名单；目录测试和探针测试会在新表出现时提醒检查。/ Refusal is by table: a future table that stores a secret must be added; the catalog and canary tests are where that is noticed.
