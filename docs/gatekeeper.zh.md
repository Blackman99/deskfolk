# Gatekeeper 首次打开 FAQ（未签名 Alpha）

Real Bot 的 Alpha `.dmg` **尚未公证**。首次打开时 macOS Gatekeeper 会拦截，这在 [Apple 公证](notarization.md) 完成前是预期行为（跟踪：[issue #10](https://github.com/Blackman99/real-bot/issues/10)）。

## 为什么会提示

未带 Developer ID + 公证的下载会被系统视为不可信。Alpha 刻意保持未签名，是为了先把签名路径走通，并不代表应用会回传或偷偷装后台。

## 首次打开（两步）

1. 在 Finder 里对 `Real Bot.app` **右键**（或 Control-点击）→ **打开**。
2. 在对话框里确认 **打开**。

![Gatekeeper：右键打开，再确认](assets/gatekeeper-2step.png)

如果已经双击被拦过，仍可用右键路径放行。

## 隔离属性（可选）

若右键 → 打开后仍被拦，可清除一次下载隔离属性：

```bash
xattr -dr com.apple.quarantine "/Applications/Real Bot.app"
```

然后再打开应用。这只去掉隔离标记，**不会**关闭系统级 Gatekeeper。

## 应用内更新不会再被拦一次

第一次放行之后，「关于」里的「下载并安装」是应用自己下载并替换自己：字节不经过浏览器，因此不会被打上下载隔离属性，也就不会再走一次右键 → 打开。这也意味着这条路的信任完全来自下载地址——它被限定在本仓库 releases 的 `.dmg`，并且安装前会校验镜像里那份应用的 identifier 和版本号。装不了的情况（别人装的那份、从源码跑的）仍然给浏览器下载，那一份下载回来照常按上面两步放行。

## 打开之后：昂贵动作仍会先问你

越过 Gatekeeper 不等于应用内权限全开。在 Real Bot 里：

- 新建模型端点 / MCP、工作区外读写、出站网络都会停在**批准卡**上。
- 高成本或不可逆的工具调用需要你明确放行——Bot 不会在未批准时静默「稍后发送」或空转烧额度。
- API 密钥进钥匙串，不进聊天。

Gatekeeper 管的是 **系统是否信任这个二进制**；批准卡管的是 **你是否信任每一次昂贵或危险动作**。

## 尚未公证

在 Developer ID 构建真正发出之前，我们不会宣称应用已签名或已公证。进度与清单：[公证路径](notarization.md) · [issue #10](https://github.com/Blackman99/real-bot/issues/10)。

## 相关

- [README — 获取](../README.zh.md#获取)
- [开发说明](development.md)
