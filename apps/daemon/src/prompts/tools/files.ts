import type { ToolDef } from "../tool-schema";

export const PATH_DESC = {
  zh: "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。",
  en: "Workspace-relative POSIX, or a host absolute path. `.` is the workspace root. A leading `/` is not the workspace root.",
} as const;

export const FILE_TAIL = {
  zh: "区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
  en: "Runs immediately inside the workspace; outside, it pauses for the user's approval. A denial comes back as denied.",
} as const;

export const READ_FILE: ToolDef = {
  name: "read_file",
  description: {
    zh: `读取 UTF-8 文本。${FILE_TAIL.zh}`,
    en: `Read UTF-8 text. ${FILE_TAIL.en}`,
  },
  properties: {
    path: { type: "string", description: PATH_DESC },
  },
  required: ["path"],
};

export const WRITE_FILE: ToolDef = {
  name: "write_file",
  description: {
    zh: `写入或新建 UTF-8 文本（整文件覆盖，中间目录按需创建）。${FILE_TAIL.zh}`,
    en: `Write or create UTF-8 text (overwrite the whole file; create parent directories as needed). ${FILE_TAIL.en}`,
  },
  properties: {
    path: { type: "string", description: PATH_DESC },
    content: { type: "string", description: { zh: "要写入的全文。", en: "The full text to write." } },
  },
  required: ["path", "content"],
};

export const DELETE_FILE: ToolDef = {
  name: "delete_file",
  description: {
    zh: `删除文件或目录。${FILE_TAIL.zh}`,
    en: `Delete a file or directory. ${FILE_TAIL.en}`,
  },
  properties: {
    path: { type: "string", description: PATH_DESC },
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

export const LIST_DIR: ToolDef = {
  name: "list_dir",
  description: {
    zh: `列出目录条目。${FILE_TAIL.zh}`,
    en: `List directory entries. ${FILE_TAIL.en}`,
  },
  properties: {
    path: {
      type: "string",
      description: {
        zh: `${PATH_DESC.zh}省略则为 \`.\`。`,
        en: `${PATH_DESC.en} Omit for \`.\`.`,
      },
    },
    recursive: {
      type: "boolean",
      description: { zh: "为 true 时递归列出。默认 false。", en: "When true, list recursively. Default false." },
    },
  },
};

export const SHELL: ToolDef = {
  name: "shell",
  description: {
    zh: "在工作区执行一条命令。cwd 在区内且命令里看得见的路径不越界则直接执行；否则停下来等用户批准。拒绝后工具结果是 denied。不能传「无约束」开关。",
    en: "Run a command in the workspace. Runs immediately when cwd is inside and no visible path in the command crosses out; otherwise it pauses for the user's approval. A denial comes back as denied. There is no unconstrained flag you can pass.",
  },
  properties: {
    command: { type: "string", description: { zh: "要执行的命令字符串。", en: "The command string to run." } },
    cwd: {
      type: "string",
      description: {
        zh: "工作区相对的当前目录。省略则为 `.`。`.` 是工作区根。开头的 `/` 不是工作区根。",
        en: "Workspace-relative working directory. Omit for `.`. `.` is the workspace root. A leading `/` is not the workspace root.",
      },
    },
  },
  required: ["command"],
};
