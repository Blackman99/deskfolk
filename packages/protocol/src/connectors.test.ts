import { describe, expect, test } from "bun:test";
import { CONNECTORS, connectorById, connectorFor } from "./connectors.ts";
import { isWorkspaceId } from "./providers.ts";

describe("connectorFor", () => {
  test("finds the connector and plan an address belongs to", () => {
    expect(connectorFor("https://token-plan-cn.xiaomimimo.com/v1", "openai")).toMatchObject({
      connector: { id: "xiaomi" },
      plan: { id: "token-plan-cn" },
    });
    expect(connectorFor("https://dashscope-intl.aliyuncs.com/compatible-mode/v1", undefined)).toMatchObject({
      connector: { id: "qwen" },
      plan: { id: "payg-intl" },
    });
    expect(connectorFor("https://api.deepseek.com/", "openai")).toMatchObject({ connector: { id: "deepseek" }, plan: { id: "api" } });
  });

  test("ignores case and trailing slashes, and a trailing /v1 in Anthropic's format", () => {
    for (const url of ["https://api.anthropic.com/", "https://API.anthropic.com", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/"]) {
      expect(connectorFor(url, "anthropic")?.connector.id).toBe("anthropic");
    }
    expect(connectorFor("https://Token-Plan-CN.xiaomimimo.com/v1/", "openai")?.plan.id).toBe("token-plan-cn");
  });

  test("the format has to match", () => {
    expect(connectorFor("https://api.anthropic.com", "openai")).toBeNull();
    expect(connectorFor("https://api.xiaomimimo.com/v1", "anthropic")).toBeNull();
  });

  test("any other address, or none, is no connector", () => {
    expect(connectorFor("https://api.xiaomimimo.com/anthropic", "openai")).toBeNull();
    expect(connectorFor("https://cpa.example.com/v1", "openai")).toBeNull();
    expect(connectorFor("https://api.anthropic.com/v1?x=1", "anthropic")).toBeNull();
    expect(connectorFor("https://api.anthropic.com?x=1", "anthropic")).toBeNull();
    expect(connectorFor("https://api.anthropic.com#top", "anthropic")).toBeNull();
    expect(connectorFor("https://user@api.anthropic.com", "anthropic")).toBeNull();
    expect(connectorFor("ftp://api.anthropic.com", "anthropic")).toBeNull();
    expect(connectorFor("", "openai")).toBeNull();
    expect(connectorFor(null, "openai")).toBeNull();
    expect(connectorFor("not a url", "openai")).toBeNull();
  });

  test("no two plans share an address", () => {
    const seen = new Set<string>();
    for (const connector of CONNECTORS) {
      for (const plan of connector.plans) {
        expect(seen.has(plan.baseUrl)).toBe(false);
        seen.add(plan.baseUrl);
        expect(connectorFor(plan.baseUrl, connector.apiFormat)).toEqual({ connector, plan });
      }
    }
  });

  test("connectorById", () => {
    expect(connectorById("qwen")?.plans[0]?.id).toBe("token-plan");
    expect(connectorById("nope")).toBeNull();
  });
});

describe("isWorkspaceId", () => {
  test("takes Anthropic's wrkspc_ ids only", () => {
    expect(isWorkspaceId("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ")).toBe(true);
    expect(isWorkspaceId("wrkspc_")).toBe(false);
    expect(isWorkspaceId(" wrkspc_01Jw")).toBe(false);
    expect(isWorkspaceId("wrkspc_01Jw-x")).toBe(false);
    expect(isWorkspaceId("01JwQvzr7rXLA5AGx3HKfFUJ")).toBe(false);
    expect(isWorkspaceId(null)).toBe(false);
  });
});
