import type { CopyShape } from "./shape.ts";

export const zh = {
  title: "Claude Agent",
  hint: "让 Bot 由你本机安装并登录的 Claude Code 来跑：在 Bot 面板的「运行方式」里逐个开启。Deskfolk 只启动它、问它自己的状态，不经手你的 Claude 登录和凭据。用量记在它登录的账号上；应用自己的判断（读句、分类、要不要接话）照旧用端点。",
  path: "位置",
  version: "版本",
  account: "账号",
  network: "网络",
  direct: "直连",
  proxySource: { env: "环境变量", system: "系统代理" } as Record<string, string>,
  source: { setting: "你填的路径", path: "PATH", known: "常见安装位置", login_shell: "登录 shell" } as Record<string, string>,
  notFound: "没找到 claude。装好 Claude Code 后点「重新检测」，或在下面填它的完整路径。",
  signedOut: "还没登录：在终端里运行 claude 登录。",
  apiKey: "用的是 API key：Bot 的每一轮按 token 计费。",
  baseUrl: "设了 ANTHROPIC_BASE_URL：Claude Code 的请求会发到那里。",
  outdated: (version: string) => `版本低于 Deskfolk 带的 Agent SDK（${version}），有些功能可能用不了：在终端里运行 claude update。`,
  recheck: "重新检测",
  checking: "检测中…",
  pathPlaceholder: "claude 的完整路径，留空则自动查找",
  pathSave: "保存路径",
  failed: "没查到，再试一次",
  localOnly: "只能在电脑上查看。",
  subscription: (plan: string) => `Claude ${plan} 订阅`,
  methods: {
    "claude.ai": "Claude 订阅",
    oauth_token: "长期令牌（Claude 订阅）",
    api_key: "API key（按 token 计费）",
    api_key_helper: "apiKeyHelper（按 token 计费）",
    third_party: "第三方平台（Bedrock / Vertex / Foundry）",
    none: "未登录"
  } as Record<string, string>
};

export const en: CopyShape<typeof zh> = {
  title: "Claude Agent",
  hint: "Let a Bot be run by the Claude Code you installed and signed in to on this computer: turn it on per Bot under \"Runs on\" in the Bot panel. Deskfolk only starts it and asks it about itself; it never handles your Claude sign-in or credentials. Usage counts against the account it is signed in with; the app's own judgements (reading lines, filing, who joins in) still run on your endpoints.",
  path: "Location",
  version: "Version",
  account: "Account",
  network: "Network",
  direct: "Direct",
  proxySource: { env: "environment", system: "system proxy" } as Record<string, string>,
  source: { setting: "the path you set", path: "PATH", known: "a usual install place", login_shell: "your login shell" } as Record<string, string>,
  notFound: "claude was not found. Install Claude Code and press Check again, or give its full path below.",
  signedOut: "Not signed in: run claude in a terminal and sign in.",
  apiKey: "It uses an API key: every Bot turn is billed per token.",
  baseUrl: "ANTHROPIC_BASE_URL is set: Claude Code sends its requests there.",
  outdated: (version: string) => `Older than the Agent SDK Deskfolk ships with (${version}); some things may not work: run claude update in a terminal.`,
  recheck: "Check again",
  checking: "Checking…",
  pathPlaceholder: "Full path to claude; leave empty to look for it",
  pathSave: "Save path",
  failed: "Could not check; try again",
  localOnly: "Only visible on the computer itself.",
  subscription: (plan: string) => `Claude ${plan} subscription`,
  methods: {
    "claude.ai": "Claude subscription",
    oauth_token: "Long-lived token (Claude subscription)",
    api_key: "API key (billed per token)",
    api_key_helper: "apiKeyHelper (billed per token)",
    third_party: "Third-party platform (Bedrock / Vertex / Foundry)",
    none: "Not signed in"
  } as Record<string, string>
};
