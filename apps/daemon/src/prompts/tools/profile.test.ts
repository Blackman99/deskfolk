import { describe, expect, test } from "bun:test";
import { UPDATE_PROFILE, updateProfileTool } from "./profile";

describe("updateProfileTool", () => {
  test.skipIf(process.platform === "win32")("this machine defaults to sh, so the static export matches the explicit sh call", () => {
    expect(UPDATE_PROFILE).toEqual(updateProfileTool("sh"));
  });

  test("sh's avatar_path description is byte-identical to the original POSIX text", () => {
    const tool = updateProfileTool("sh");
    expect(tool.properties.avatar_path?.description).toEqual({
      zh: "工作区相对 POSIX，或宿主绝对路径，指向一张 PNG / JPEG / GIF / WebP。区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
      en: "Workspace-relative POSIX, or a host absolute path, to a PNG / JPEG / GIF / WebP. Runs immediately inside the workspace; outside, it pauses for the user's approval. A denial comes back as denied.",
    });
  });

  test("bash and powershell both describe a native Windows absolute path for the avatar file", () => {
    for (const shell of ["bash", "powershell"] as const) {
      const desc = updateProfileTool(shell).properties.avatar_path?.description;
      expect(desc?.zh).toContain("C:\\Users\\me\\avatar.png");
      expect(desc?.en).toContain("C:\\Users\\me\\avatar.png");
      expect(desc?.en).toContain("PNG / JPEG / GIF / WebP");
    }
  });

  test("everything besides avatar_path is unaffected by shell kind", () => {
    const sh = updateProfileTool("sh");
    const powershell = updateProfileTool("powershell");
    expect(sh.description).toEqual(powershell.description);
    expect(sh.properties.name).toEqual(powershell.properties.name);
    expect(sh.properties.thinking_level).toEqual(powershell.properties.thinking_level);
  });
});
