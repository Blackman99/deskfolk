import { expect, test } from "bun:test";
import { scrubbedEnv } from "./env";

test("the runtimes' environment keeps what a shell and the endpoint need, and drops keys and the app's switches", () => {
  const env = scrubbedEnv(
    {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
      LANG: "zh_CN.UTF-8",
      MY_EVAL_KEY: "sk-live",
      OPENAI_API_KEY: "sk-other",
      GITHUB_TOKEN: "ghp_x",
      AWS_SECRET_ACCESS_KEY: "x",
      REAL_BOT_DEV_REMOTE: "1",
      REAL_BOT_DATA_DIR: "/tmp/x",
      FORCE_COLOR: "3",
      EMPTY: undefined,
    },
    "MY_EVAL_KEY",
  );
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1", LANG: "zh_CN.UTF-8" });
});
