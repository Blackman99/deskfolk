# Bot 经轮次批准改名册级端点和 MCP

端点和 MCP 是账户级信任根，不是每 Bot 一份。Bot 可以 list / add / update / delete，但新建端点、改已有 URL、新增 MCP、改 command·args 必须每次批准，不能 Always allow；密钥只出现在批准卡的 resolve 请求里，不进工具参数、转录或事件。HTTP MCP 新增的批准卡 `requires_api_key` 为真：允许一次必须贴 Authorization，否则 `422`、卡仍 pending。默认端点的 URL / 密钥 / 删除仍只有你在设置里做——那是向导完成条件的根，不能让一轮工具拆掉。已配 MCP 的 `tools/call` 和往已有名单整表替换模型名仍直接干，信任点留在安装 / 改 URL。所有已启用且连接成功的 MCP 工具每次补全均可用，不按开轮触发条、消息语言或 Bot 身份筛选。新增、改连接或重新启用在当前轮次下一跳生效，其他 Bot 和后续会话同样可用；停用、删除后拒绝调用。此前只保留安装当轮的做法会让中文图片 / 视频请求和「再来一张」等后续消息失去工具，已移除。

## 2026-10-08：模型的属性和全局模型设置

你问「当前支持 Bot 更改应用里的模型上下文以及其他的配置吗」，答案是端点、MCP、自己的资料能改，模型的上下文窗口实际改不了（守护进程收，工具说明没写），默认端点、读句模型、模型阶梯没有工具。于是：

- **模型条目上的属性**：`add_endpoint` / `update_endpoint` 的名单项多了 `context_window`、`input_image`、`max_output`（[ADR 0067](0067-local-model-servers.md)）。工具说明写明每一项整项替换这个模型的设置：没写的 `price`、`pricing` 清空，`thinking_levels` 回到 none/low/medium/high，`strengths` 清空；这三个和测出的速度没写就保留，写 `null` 才清掉；只想改一个字段就从 `list_endpoints` 的 `model_catalog` 把这一项整个抄过来。只写名字字符串会把价格和思考等级重置掉——这是原有的语义（`pricing-api.test.ts` 用它清单价），不改，只说清楚。
- **`measure_model`**：设置里「测一下」的同一个测速，Bot 也能对一个已启用模型跑；跟着这一轮的 Stop 一起停。速度的六成记进 `stream_tps_p10`。
- **`update_model_settings`**：改默认端点、读句用的模型、模型阶梯（从弱到强，需引擎第 7 级）。`list_endpoints` 同时返回 `reader_model` 和 `model_ladder`，先读再改。设成默认端点的必须有密钥（本机 / 局域网的除外）且名单不空，不然没钉模型的 Bot 无处可跑。阶梯和设置在同一个事务里写，要么都成、要么都不成。
- **不等批准**：这几样都是在你已经配好的端点和模型里挑，没有密钥或地址去到新的地方，和「改某个端点的默认模型」一样直接执行（[ADR 0058](0058-the-app-asks-only-when-it-needs-you.md)：卡片只留给只有你能定的事）。代价是一个 Bot 能把所有没钉模型的 Bot 换到另一个模型上，花费跟着变；工具说明要求它先 `list_endpoints` 看清、改完告诉你。要改成走批准卡，只需在 `update_model_settings` 里像 `add_endpoint` 那样返回 `waitApproval`。
- **仍然不归 Bot**：别的 Bot 钉的模型（`update_profile` 只改自己）、工作区目录、「总是允许」规则、远程控制、独立运行时、通知、语言和外观。前四样牵涉访问边界，后几样是你个人的偏好。
