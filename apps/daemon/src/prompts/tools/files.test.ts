import { describe, expect, test } from "bun:test";
import {
  DELETE_FILE,
  FILE_TAIL,
  LIST_DIR,
  PATH_DESC,
  READ_FILE,
  SHELL,
  WRITE_FILE,
  deleteFileTool,
  listDirTool,
  pathDesc,
  readFileTool,
  shellTool,
  writeFileTool,
} from "./files";

describe("the static exports are the 'sh' (today's POSIX) shape by default", () => {
  test("this machine's toolShell() defaults to sh, so the static exports match the explicit sh call", () => {
    expect(PATH_DESC).toEqual(pathDesc("sh"));
    expect(READ_FILE).toEqual(readFileTool("sh"));
    expect(WRITE_FILE).toEqual(writeFileTool("sh"));
    expect(DELETE_FILE).toEqual(deleteFileTool("sh"));
    expect(LIST_DIR).toEqual(listDirTool("sh"));
    expect(SHELL).toEqual(shellTool("sh"));
  });
});

describe("pathDesc", () => {
  test("sh (macOS/Linux) is byte-identical to the original POSIX text", () => {
    expect(pathDesc("sh")).toEqual({
      zh: "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。",
      en: "Workspace-relative POSIX, or a host absolute path. `.` is the workspace root. A leading `/` is not the workspace root.",
    });
  });

  test("bash (Git Bash on win32) and powershell both describe native Windows absolute paths", () => {
    for (const shell of ["bash", "powershell"] as const) {
      const desc = pathDesc(shell);
      expect(desc.zh).toContain("C:\\Users\\me\\ws");
      expect(desc.en).toContain("C:\\Users\\me\\ws");
      expect(desc.zh).toContain("`/`");
      expect(desc.en).toContain("`/`-separated");
      // The workspace-relative wire format is unchanged (contract §7): still "." / leading "/".
      expect(desc.zh).toContain("`.` 是工作区根");
      expect(desc.en).toContain("`.` is the workspace root");
    }
  });
});

describe("shellTool", () => {
  test("sh matches today's shell tool description and cwd property exactly", () => {
    const tool = shellTool("sh");
    expect(tool.description).toEqual({
      zh: "在工作区执行一条命令，默认在本轮工作目录里。cwd 在区内且命令里看得见的路径不越界则直接执行；否则停下来等用户批准。拒绝后工具结果是 denied。不能传「无约束」开关。",
      en: "Run a command in the workspace, by default in this turn's work dir. Runs immediately when cwd is inside and no visible path in the command crosses out; otherwise it pauses for the user's approval. A denial comes back as denied. There is no unconstrained flag you can pass.",
    });
    expect(tool.properties.cwd?.description).toEqual({
      zh: "工作区相对的当前目录。省略则为本轮工作目录（局面块里那一行）。`.` 是工作区根。开头的 `/` 不是工作区根。",
      en: "Workspace-relative working directory. Omit for this turn's work dir (the line in the situation block). `.` is the workspace root. A leading `/` is not the workspace root.",
    });
  });

  test("bash (Git Bash) names itself and keeps bash syntax, no PowerShell caveat", () => {
    const tool = shellTool("bash");
    expect(tool.description.zh).toContain("Git Bash");
    expect(tool.description.en).toContain("Git Bash");
    expect(tool.description.en).toContain("bash syntax");
    expect(tool.description.en).not.toContain("timeout wrapper");
  });

  test("powershell names itself, uses PowerShell syntax, and calls out no timeout wrapper", () => {
    const tool = shellTool("powershell");
    expect(tool.description.zh).toContain("PowerShell");
    expect(tool.description.en).toContain("PowerShell syntax");
    expect(tool.description.en).toContain("no timeout wrapper");
    expect(tool.description.en).toContain("Start-Process");
    expect(tool.description.zh).toContain("timeout");
    expect(tool.description.zh).toContain("Start-Process");
  });

  test("every shell kind still pauses for approval and forbids an unconstrained flag", () => {
    for (const shell of ["sh", "bash", "powershell"] as const) {
      const tool = shellTool(shell);
      expect(tool.description.zh).toContain("denied");
      expect(tool.description.en).toContain("denied");
      expect(tool.description.en).toContain("no unconstrained flag");
    }
  });
});

describe("read_file/write_file/delete_file/list_dir stay byte-identical on sh and gain Windows path wording elsewhere", () => {
  test("write_file sh matches the original text", () => {
    const tool = writeFileTool("sh");
    expect(tool.description).toEqual({
      zh: `写入或新建 UTF-8 文本（整文件覆盖，中间目录按需创建）。${FILE_TAIL.zh}`,
      en: `Write or create UTF-8 text (overwrite the whole file; create parent directories as needed). ${FILE_TAIL.en}`,
    });
    expect(tool.properties.path?.description).toEqual(pathDesc("sh"));
  });

  test("list_dir's path description on powershell/bash still ends with the 'omit for .' sentence", () => {
    const tool = listDirTool("powershell");
    expect(tool.properties.path?.description.en).toContain("Omit for `.`");
    expect(tool.properties.path?.description.en).toContain("C:\\Users\\me\\ws");
  });

  test("delete_file's recursive flag description is unaffected by shell kind", () => {
    expect(deleteFileTool("sh").properties.recursive).toEqual(deleteFileTool("powershell").properties.recursive);
  });
});
