# macOS 上所有凭据合成一个钥匙串项

[ADR 0010](0010-daemon-owns-keychain-runtime-token.md) 让守护进程用 `Bun.secrets` 给每个端点、每个 MCP 服务器各存一项（`com.real-bot.daemon` / `endpoint-api-key:<id>`、`mcp-auth:<id>`）。在发布包上，这让每次安装新版本之后的第一次启动都连着弹好几个钥匙串对话框，每个都要输登录密码：

- **钥匙串按签名认程序。** 旧式钥匙串项有一张分区列表，写着哪些签名身份可以不问就读。`pnpm dev` 跑的 `~/.bun/bin/bun` 是 Bun 的 Developer ID 签名（`teamid:7FRXF46ZSN`），跨版本不变，所以源码态从来不弹。
- **ad-hoc 签名每版都是新程序。** 发布包的 `real-bot-daemon` 没有 Team ID，钥匙串只能记它的 `cdhash`，也就是二进制内容的哈希。每发一版 cdhash 都变，旧的「始终允许」对新版本不作数。
- **一项弹一次。** 守护进程启动时会读每个端点和每个 MCP 的凭据，配了几个就弹几个。2026-09-28 维护者的 Mac 上有 5 项，每项的分区列表都攒了好几个旧版本的 cdhash。

## 现在

- **macOS 上只有一项。** `com.real-bot.daemon` / `credentials` 存一个 JSON：`{ v: 1, keys: { <名字>: <值> }, migrated: [<名字>] }`。守护进程每次启动最多读它一次，所以每装一个新版本最多弹一次。`secrets.ts` 的 `bundledKeyStore` 实现它；上层的 `EndpointKeyStore` 和 `KeyCache` 不变，名字也还是原来那些。
- **旧项读一次、折进来、留着。** 合并项里没有、`migrated` 里也没有的名字，去读一次它原来的单项（每个旧项最后弹一次），读到就写进合并项并记进 `migrated`。旧项不删：回装一个老版本时它照样找得到 key。在新版本里改或删这个 key 时，才顺手删掉旧项（删不掉也不要紧，`migrated` 保证它不会再被读回来）。
- **读不到就不写。** 被拒绝或钥匙串锁着（`Bun.secrets.get` 报错，不是返回 null），这次运行里之后的读都当成没有 key，不再问；写会再读一次，读不到就报错，绝不拿一个空的合并项盖掉整项。认不出的布局（更新版本写的、或者损坏了）同样只读不写。
- **别的平台还是一名一项。** Windows 凭据管理器和 Linux libsecret 不会因为程序换了签名就来问人，而且凭据管理器单条大约只能放 2.5 KB，把全部凭据塞进一条反而会撞上限。`perNameKeyStore` 保持原来的行为。
- **根治是 Developer ID。** 有了 Team ID，分区列表记的是 `teamid:<TEAMID>`，以后怎么更新都不用再问。`release.yml` 在仓库配了 `APPLE_SIGNING_IDENTITY` 等 secrets 时导入证书、签名并公证（见 [notarization](../notarization.md)），没配时照旧 ad-hoc。合并成一项在那之后仍然有用：换签名那一版只问一次，而不是每项问一次。

## 取舍

合并项的每次写入都要重写整个 JSON，所以几个进程同时写会互相覆盖。守护进程是唯一写凭据的进程（ADR 0010），`demo-tape.ts` 这类脚本只读，所以这不是问题。它们读的时候也可能把旧项折进来，就算被守护进程覆盖掉，旧项还在，下次还会再折一次。

## 不做

- 不设 `allowUnrestrictedAccess`。那样确实一次都不弹，但任何以你身份运行的程序，包括被网页或文件带偏的 Bot 跑的 shell 命令，一条 `security find-generic-password -w` 就能悄悄拿走 key。现在别的程序来读，系统至少会弹框问你。
- 不改成数据目录里的文件。原因同上，而且 key 会以明文进备份和网盘同步。远控凭据放在文件里（[ADR 0033](0033-remote-credentials-in-a-file.md)），是因为发布包别无他法；端点 key 在钥匙串里有路可走。
