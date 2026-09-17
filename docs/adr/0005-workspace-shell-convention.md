# v1 工作区壳是约定加启动前检查

macOS 没有把子进程文件系统关进调用方所选工作区目录的受支持 API。Seatbelt 自定义 profile 在 2026 仍能拦 `open`，但 `sandbox-exec` / `sandbox.h` 已废弃，语言是 Apple 私有接口，且不拦已打开 fd；App Sandbox 的可写根是 `~/Library/Containers`，不是用户选的工作区。v1 不拿这两套冒充工作区囚笼：工作区壳 = cwd + 启动前路径检查，文件工具由守护进程按同一套 `realpath` 规则打开。产品必须写明壳不是操作系统囚笼。以后若出现一等 API 再升级，不在 v1 赌废弃私有接口。
