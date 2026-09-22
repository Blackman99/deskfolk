import { describe, expect, it } from "bun:test";
import {
  classifyBotMessage,
  renderNotificationDisplay,
  truncateCodePoints,
} from "./notification-policy.ts";

describe("notification-policy", () => {
  it("classifies direct messages to user as reply or routine_result", () => {
    const directReply = classifyBotMessage({
      kind: "bot",
      body: "Here is your report",
      author: "Writer",
      sessionKind: "direct",
      isUserPresent: true,
      rosterNames: ["Writer", "Researcher"],
    });
    expect(directReply).toBe("reply");

    const routineResult = classifyBotMessage({
      kind: "bot",
      body: "Daily brief completed",
      author: "Writer",
      sessionKind: "direct",
      isUserPresent: true,
      rosterNames: ["Writer", "Researcher"],
      isRoutineRoot: true,
    });
    expect(routineResult).toBe("routine_result");
  });

  it("suppresses messages where user is not present (Bot↔Bot)", () => {
    const suppressed = classifyBotMessage({
      kind: "bot",
      body: "Here is data for you",
      author: "Writer",
      sessionKind: "direct",
      isUserPresent: false,
      rosterNames: ["Writer", "Researcher"],
    });
    expect(suppressed).toBeNull();
  });

  it("classifies group messages triggered by or quoting user, unless handing off to other bots", () => {
    // Triggered by user, no bot mention -> reply
    expect(
      classifyBotMessage({
        kind: "bot",
        body: "All done!",
        author: "Writer",
        sessionKind: "group",
        isUserPresent: true,
        triggerAuthor: "user",
        rosterNames: ["Writer", "Researcher"],
      }),
    ).toBe("reply");

    // Triggered by user, but mentions Researcher to hand off -> suppressed
    expect(
      classifyBotMessage({
        kind: "bot",
        body: "@Researcher please check this",
        author: "Writer",
        sessionKind: "group",
        isUserPresent: true,
        triggerAuthor: "user",
        rosterNames: ["Writer", "Researcher"],
      }),
    ).toBeNull();

    // Triggered by another bot, but quotes user -> reply
    expect(
      classifyBotMessage({
        kind: "bot",
        body: "Answering your previous question",
        author: "Writer",
        sessionKind: "group",
        isUserPresent: true,
        triggerAuthor: "bot_123",
        parentAuthor: "user",
        rosterNames: ["Writer", "Researcher"],
      }),
    ).toBe("reply");

    // Triggered by another bot, does not quote user -> null
    expect(
      classifyBotMessage({
        kind: "bot",
        body: "Internal sync",
        author: "Writer",
        sessionKind: "group",
        isUserPresent: true,
        triggerAuthor: "bot_123",
        parentAuthor: "bot_123",
        rosterNames: ["Writer", "Researcher"],
      }),
    ).toBeNull();
  });

  it("truncates Unicode code points correctly", () => {
    const text = "👍🏽你好world";
    expect(truncateCodePoints(text, 5)).toBe("👍🏽你好w");
  });

  it("renders notification displays with limits", () => {
    const display = renderNotificationDisplay({
      kind: "approval",
      botName: "Writer",
      approvalSummary: "Write to outside folder /tmp/data",
    });
    expect(display.title).toBe("Writer · 等你批准");
    expect(display.summary).toBe("Write to outside folder /tmp/data");
  });
});
