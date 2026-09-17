## Summary / 改动摘要

What problem does this solve? Link the issue or describe the agreed scope.

解决什么问题？关联 Issue 或说明已讨论的范围。

## Changes and limitations / 变更与限制

Distinguish implemented behavior from WIP goals.

区分已实现行为与尚未完成的目标。

## Verification / 验证

Record actual results; explain any check that was not run.

记录实际结果，未运行的检查请说明原因。

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- [ ] `pnpm --filter @real-bot/messenger build`
- [ ] `pnpm --filter @real-bot/landing build` when landing-page files change, or not applicable / 改落地页时已构建，或不适用
- [ ] UI changes exercised end to end, including shared state and edge cases, or not applicable / 已完成 UI 端到端、共享状态与边界验证，或不适用
- [ ] Layout changes checked at desktop and narrow viewports, or not applicable / 已检查桌面与窄屏布局，或不适用
- [ ] Native macOS behavior checked when affected, or not applicable / 已检查相关原生行为，或不适用

Describe interactions, results, and remaining verification gaps. Screenshots supplement behavior checks; redact private data.

说明实际操作、结果与尚未验证的部分。截图不能代替行为检查；上传前脱敏。

## Documentation and safety / 文档与安全

- [ ] Relevant docs and both READMEs updated, or not applicable / 相关文档与中英文 README 已同步，或不适用
- [ ] User-facing changes recorded under `Unreleased`, or not applicable / 用户可见变更已记入 `Unreleased`，或不适用
- [ ] Secrets, runtime data, and local artifacts excluded / 已排除密钥、运行数据与本地产物
- [ ] Third-party notices retained or updated when needed / 已按需保留或更新第三方声明
- [ ] Changes to permissions, data transmission, and approval behavior described / 已说明权限、数据外发和批准行为的变化
