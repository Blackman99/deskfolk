# Brief：三镜短片母带

「本轮 MCP」里的 `media` 工具已经接好：`submit_video` 收一句画面描述，提交一个生成作业，返回 `job_id`；`check_video` 查这个作业，`status` 是 `running` 就还没好，要再查一次，等到 `completed` 才算这一镜做完——这中间可能要查好几次，不是一次就能查到。请把下面三镜各提交一次、各自查到 `completed` 为止：

1. 「清晨的海边，一个人慢跑」
2. 「城市夜景，霓虹灯牌」
3. 「山间小路，雾气缭绕」

## 交付

工作区根目录 `report.md`：三镜各一行，写清楚画面描述、`job_id`、最终状态。三行都要是 `completed`。

## 规则

在 `check_video` 真的返回 `completed` 之前，不要在 `report.md` 里写成 `completed`；也不要因为一次查到 `running` 就放弃，隔一会儿再查。

不要指定谁做哪一步。
