import type { Localized, ToolDef } from "../tool-schema";
import { toolShell, type ToolShellKind } from "../../platform";

/**
 * `PATH_DESC`/`SHELL` are computed once, at module load, from the daemon's own `toolShell()` —
 * which itself defaults to the real `process.platform`/`process.env` — so on macOS/Linux this is
 * exactly today's text (verified byte-for-byte in prompts.test.ts) and on an actual win32 daemon
 * it is the Windows text below, with no caller (`builtin-tools.ts`, `tools/annotations.ts`) having
 * to change: they still just import a plain `Localized`/`ToolDef` value, as before. The `*ToolDef`/
 * `pathDesc` functions underneath are exported too, so a different shell kind can be exercised
 * directly in tests without a real Windows machine.
 */
export function pathDesc(shell: ToolShellKind = toolShell().kind): Localized {
  if (shell === "sh") {
    return {
      zh: "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。",
      en: "Workspace-relative POSIX, or a host absolute path. `.` is the workspace root. A leading `/` is not the workspace root.",
    };
  }
  // Only "bash" (Git Bash) and "powershell" ever come back from toolShell() on win32; the wire
  // format stays `/`-separated but a host absolute path is a native Windows path.
  return {
    zh: "工作区相对路径用 `/` 分隔，或宿主绝对路径（原生 Windows 路径，如 `C:\\Users\\me\\ws`）。`.` 是工作区根。开头的 `/` 不是工作区根。",
    en: "Workspace-relative paths are `/`-separated, or a host absolute path (a native Windows path, e.g. `C:\\Users\\me\\ws`). `.` is the workspace root. A leading `/` is not the workspace root.",
  };
}

export const PATH_DESC: Localized = pathDesc();

/** A write or delete: the Bot's permission mode decides, not the workspace (ADR 0092). */
export const FILE_TAIL = {
  zh: "要不要等用户批准看你的权限模式（自动、全部允许下直接执行，改动先问下等批准，只读下被拒），和路径在不在工作区里无关。拒绝后工具结果是 denied。",
  en: "Whether it waits for the user's approval is set by your permission mode (runs at once under auto and allow all, waits under ask first, refused read-only), wherever the path is. A denial comes back as denied.",
} as const;

/** A read never waits, in any permission mode (ADR 0092). */
export const READ_TAIL = {
  zh: "读不用批准，路径在哪都行。",
  en: "Reading never waits for approval, wherever the path is.",
} as const;

export function readFileTool(shell: ToolShellKind = toolShell().kind): ToolDef {
  return {
    name: "read_file",
    description: {
      zh: `读取 UTF-8 文本；PNG / JPEG / GIF / WebP 图片会作为图像附在这批工具结果之后给你看。${READ_TAIL.zh}`,
      en: `Read UTF-8 text; a PNG / JPEG / GIF / WebP picture is shown to you as an image after this batch of tool results. ${READ_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: pathDesc(shell) },
    },
    required: ["path"],
  };
}

export const READ_FILE: ToolDef = readFileTool();

export function writeFileTool(shell: ToolShellKind = toolShell().kind): ToolDef {
  return {
    name: "write_file",
    description: {
      zh: `写入或新建 UTF-8 文本（整文件覆盖，中间目录按需创建）。${FILE_TAIL.zh}`,
      en: `Write or create UTF-8 text (overwrite the whole file; create parent directories as needed). ${FILE_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: pathDesc(shell) },
      content: { type: "string", description: { zh: "要写入的全文。", en: "The full text to write." } },
    },
    required: ["path", "content"],
  };
}

export const WRITE_FILE: ToolDef = writeFileTool();

export function deleteFileTool(shell: ToolShellKind = toolShell().kind): ToolDef {
  return {
    name: "delete_file",
    description: {
      zh: `删除文件或目录。${FILE_TAIL.zh}`,
      en: `Delete a file or directory. ${FILE_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: pathDesc(shell) },
      recursive: {
        type: "boolean",
        description: {
          zh: "为 true 时删除非空目录。默认 false。非空目录且未设则为失败。",
          en: "When true, delete a non-empty directory. Default false. A non-empty directory without this flag fails.",
        },
      },
    },
    required: ["path"],
  };
}

export const DELETE_FILE: ToolDef = deleteFileTool();

export function listDirTool(shell: ToolShellKind = toolShell().kind): ToolDef {
  const path = pathDesc(shell);
  return {
    name: "list_dir",
    description: {
      zh: `列出目录条目。${READ_TAIL.zh}`,
      en: `List directory entries. ${READ_TAIL.en}`,
    },
    properties: {
      path: {
        type: "string",
        description: {
          zh: `${path.zh}省略则为 \`.\`。`,
          en: `${path.en} Omit for \`.\`.`,
        },
      },
      recursive: {
        type: "boolean",
        description: { zh: "为 true 时递归列出。默认 false。", en: "When true, list recursively. Default false." },
      },
    },
  };
}

export const LIST_DIR: ToolDef = listDirTool();

function shellDescription(shell: ToolShellKind): Localized {
  if (shell === "sh") {
    return {
      zh: "在工作区执行一条命令，默认在本轮工作目录里。要不要等用户批准看你的权限模式，和命令碰到哪些路径无关。拒绝后工具结果是 denied。",
      en: "Run a command in the workspace, by default in this turn's work dir. Whether it waits for the user's approval is set by your permission mode, not by the paths the command touches. A denial comes back as denied.",
    };
  }
  if (shell === "bash") {
    return {
      zh: "在工作区执行一条命令（Git Bash，bash 语法），默认在本轮工作目录里。要不要等用户批准看你的权限模式，和命令碰到哪些路径无关。拒绝后工具结果是 denied。",
      en: "Run a command in the workspace (Git Bash, bash syntax), by default in this turn's work dir. Whether it waits for the user's approval is set by your permission mode, not by the paths the command touches. A denial comes back as denied.",
    };
  }
  return {
    zh: "在工作区执行一条命令（PowerShell 语法），默认在本轮工作目录里。没有 timeout 包装器：要限时或放后台运行，用 Start-Process 或后台任务（Job）并自己控制时长。要不要等用户批准看你的权限模式，和命令碰到哪些路径无关。拒绝后工具结果是 denied。",
    en: "Run a command in the workspace (PowerShell syntax), by default in this turn's work dir. There is no timeout wrapper: for a time limit or to run in the background, use Start-Process or a background job and control the duration yourself. Whether it waits for the user's approval is set by your permission mode, not by the paths the command touches. A denial comes back as denied.",
  };
}

function cwdDescription(shell: ToolShellKind): Localized {
  if (shell === "sh") {
    return {
      zh: "工作区相对的当前目录。省略则为本轮工作目录（局面块里那一行）。`.` 是工作区根。开头的 `/` 不是工作区根。",
      en: "Workspace-relative working directory. Omit for this turn's work dir (the line in the situation block). `.` is the workspace root. A leading `/` is not the workspace root.",
    };
  }
  return {
    zh: "工作区相对的当前目录，用 `/` 分隔。省略则为本轮工作目录（局面块里那一行）。`.` 是工作区根。开头的 `/` 不是工作区根。",
    en: "Workspace-relative working directory, `/`-separated. Omit for this turn's work dir (the line in the situation block). `.` is the workspace root. A leading `/` is not the workspace root.",
  };
}

export function shellTool(shell: ToolShellKind = toolShell().kind): ToolDef {
  return {
    name: "shell",
    description: shellDescription(shell),
    properties: {
      command: { type: "string", description: { zh: "要执行的命令字符串。", en: "The command string to run." } },
      cwd: { type: "string", description: cwdDescription(shell) },
    },
    required: ["command"],
  };
}

export const SHELL: ToolDef = shellTool();
