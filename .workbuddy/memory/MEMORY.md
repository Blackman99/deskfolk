# Real Bot 项目约定

## 浮层「点外部关闭」的统一做法

所有遮罩类浮层（Bot/群设置抽屉、设置弹窗、端点编辑器、创建面板、MCP/技能编辑器、工作区浏览器、模型选择日志、危险确认框）的关闭判断统一走 `apps/messenger/src/lib/click-outside.ts`：

- `backdropClick()` 返回 `{ press, isOutside }`：`press` 绑在遮罩的 **捕获阶段**（`onmousedowncapture`），`isOutside` 绑在 `onclick`。
- 判定规则：**按下点决定一切**——按在遮罩上（即 sheet 之外）且松开也在遮罩上才关闭；按下在 sheet 内、拖出去松手永不关闭。这样复制/拖选文字不会误关。
- 不要退回 `e.target === e.currentTarget` 的写法，那会被拖选手势击穿。

## 测试与类型检查

- `bun` 在 `/opt/homebrew/bin/bun`（不在默认 PATH）。组件测试必须带 `--conditions browser`，否则 Svelte 解析到 server 构建、`mount()` 抛错。
- 组件测试用 happy-dom + `src/lib/test-render.ts` 的 `render/click/mouseDown/press`。
