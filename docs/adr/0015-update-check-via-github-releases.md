# 检查更新在浏览器打开下载，不做应用内安装

构建目前是 ad-hoc 签名（`signingIdentity: "-"`），没有 minisign 密钥，`release.yml` 也没开 `uploadUpdaterJson`，`tauri-plugin-updater` 需要的签名与 `latest.json` 都不具备，用它只会在安装环节引入一个不可信的静默替换。因此决策是「检查 + 在系统浏览器打开下载」：桌面端定时问 GitHub 有没有新 release，有就把对应的 `.dmg` 或发布页交给系统浏览器，用户仍走一次手动打开、Gatekeeper 放行的安装流程，和现在下载新版本的路径一致，只是不用自己去仓库翻。

查询与打开外链都放在窗口进程（Rust）一侧，而不是信使 webview：webview 的 CSP 把 `connect-src` 钉在回环地址，这是刻意的——聊天内容和工具输出最终会渲染进这个 webview，不应该让它顺带拿到访问任意外网的权限，哪怕只是为了读 GitHub。把请求放进 Rust 侧的 `updates.rs`，webview 只通过 Tauri 命令拿到结构化结果，CSP 不用为这一个功能开口子。同样，打开链接的新命令 `open_external_url` 只放行 `https://github.com/Blackman99/real-bot/` 前缀：Tauri v2 里 `<a target="_blank">` 不会自动交给系统浏览器，必须有自定义命令，而只要这个命令存在，webview 里任何能拼字符串的内容（将来的富文本渲染、甚至恶意工具输出）理论上都可能调用它——白名单把它限制成「只能打开这个仓库的发布相关地址」，不是一个通用的开链接接口。

版本查询用 `GET /repos/Blackman99/real-bot/releases?per_page=10` 自己在列表里挑最高 semver，而不是更省事的 `/releases/latest`：仓库到目前为止每个 release 都标了 prerelease，`/releases/latest` 只认正式 release，会稳定 404。挑选规则是当前运行版本（取自 `tauri.conf.json`）带预发布标识时，所有 release（含 prerelease）都参与比较；当前版本是正式版时只看正式 release——这样 alpha 用户能看到新的 alpha，将来切到正式版之后也不会被更新的预发布打扰。「忽略此版本」记在信使 webview 的 `localStorage`，没有经过守护进程的 `Settings` 契约：这是纯粹的界面偏好，不是需要持久化到工作区或跨设备同步的应用状态，而且浏览器开发态（无 Tauri）本来就没有「关于」卡和可更新的桌面壳，不需要为它单独准备后端存储。等以后有了签名构建和 minisign 密钥，`tauri-plugin-updater` 可以直接替换「下载」这一步去做应用内安装，检查节奏、prerelease 规则和「关于」卡片的其余部分不用跟着改。
