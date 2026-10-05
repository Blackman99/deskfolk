import { expect, test } from "bun:test";
import { claudeProxy, maskProxy, parseRegQuery, proxyFromScutil, proxyFromWindowsSettings, withSystemProxy } from "./proxy";

/** What `scutil --proxy` prints with a proxy app's "system proxy" switched on (the updater's fixture). */
const SCUTIL_PROXY_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 12334
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 12334
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 12334
  SOCKSProxy : 127.0.0.1
}
`;

const system = (dump: string | null) => async (host: string) => (dump ? proxyFromScutil(host, dump) : null);
const never = async (_host: string): Promise<string | null> => {
  throw new Error("the system was asked although the environment answered");
};

test("the environment's proxy comes first and is passed on as it is", async () => {
  expect(await claudeProxy({ HTTPS_PROXY: "http://10.0.0.2:8080" }, never)).toEqual({ url: "http://10.0.0.2:8080", source: "env" });
  expect(await claudeProxy({ https_proxy: "http://10.0.0.2:8080" }, never)).toEqual({ url: "http://10.0.0.2:8080", source: "env" });
  expect(await claudeProxy({ ALL_PROXY: "socks5://10.0.0.2:1080" }, never)).toEqual({ url: "socks5://10.0.0.2:1080", source: "env" });
  // NO_PROXY covering where Claude Code goes means straight, system setting or not.
  expect(await claudeProxy({ HTTPS_PROXY: "http://10.0.0.2:8080", NO_PROXY: ".anthropic.com" }, never)).toBeNull();
  expect(await claudeProxy({ no_proxy: "*" }, never)).toBeNull();
});

test("with no proxy variables, the system's HTTPS proxy is the one", async () => {
  expect(await claudeProxy({}, system(SCUTIL_PROXY_ON))).toEqual({ url: "http://127.0.0.1:12334", source: "system" });
  expect(await claudeProxy({}, system(SCUTIL_PROXY_ON.replace("HTTPSEnable : 1", "HTTPSEnable : 0")))).toBeNull();
  expect(await claudeProxy({}, system(null))).toBeNull();
  // An endpoint of your own: its host is what the exceptions are checked against.
  expect(await claudeProxy({ ANTHROPIC_BASE_URL: "https://gateway.corp.local/v1" }, system(SCUTIL_PROXY_ON))).toBeNull();
  expect(await claudeProxy({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, never)).toBeNull();
  expect(await claudeProxy({ ANTHROPIC_BASE_URL: "http://[::1]:8317" }, never)).toBeNull();
});

test("scutil's answer: the top-level HTTPS proxy, unless switched off, portless or excepted", () => {
  expect(proxyFromScutil("api.anthropic.com", SCUTIL_PROXY_ON)).toBe("http://127.0.0.1:12334");
  expect(proxyFromScutil("printer.local", SCUTIL_PROXY_ON)).toBeNull();
  expect(proxyFromScutil("api.anthropic.com", SCUTIL_PROXY_ON.replace("  HTTPSPort : 12334\n", ""))).toBeNull();
  const scoped = `<dictionary> {
  HTTPSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 8080
      HTTPSProxy : 10.0.0.1
    }
  }
}
`;
  expect(proxyFromScutil("api.anthropic.com", scoped)).toBeNull();
  expect(proxyFromScutil("api.anthropic.com", "")).toBeNull();
});

test("only a system proxy is added to Claude Code's environment, and only as HTTPS_PROXY", () => {
  const env = { PATH: "/usr/bin" };
  expect(withSystemProxy(env, { proxy: "http://127.0.0.1:12334", proxy_source: "system" }))
    .toEqual({ PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:12334", NO_PROXY: "localhost,127.0.0.1,::1" });
  expect(withSystemProxy({ ...env, no_proxy: "intranet" }, { proxy: "http://127.0.0.1:12334", proxy_source: "system" }))
    .toEqual({ PATH: "/usr/bin", no_proxy: "intranet", HTTPS_PROXY: "http://127.0.0.1:12334" });
  expect(withSystemProxy(env, { proxy: "http://***@10.0.0.2:8080", proxy_source: "env" })).toBe(env);
  expect(withSystemProxy(env, { proxy: null, proxy_source: null })).toBe(env);
  expect(withSystemProxy(env, null)).toBe(env);
});

test("a user and password in a proxy are hidden on the card", () => {
  expect(maskProxy("http://me:secret@10.0.0.2:8080")).toBe("http://***@10.0.0.2:8080");
  expect(maskProxy("http://10.0.0.2:8080")).toBe("http://10.0.0.2:8080");
});

// Windows ---------------------------------------------------------------------------------------

/** `reg query` of the Internet Settings key with a proxy app's "system proxy" switched on. */
const REG_QUERY = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)",
  "    CertificateRevocation    REG_DWORD    0x1",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    127.0.0.1:7890",
  "    ProxyOverride    REG_SZ    localhost;127.*;10.*;172.16.*;192.168.*;<local>",
  "    AutoDetect    REG_DWORD    0x0",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\5.0",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections",
  "",
].join("\r\n");

test("reg query's values are read by name; subkeys and other shapes are not values", () => {
  const values = parseRegQuery(REG_QUERY)!;
  expect(values.get("proxyenable")).toBe("0x1");
  expect(values.get("proxyserver")).toBe("127.0.0.1:7890");
  expect(values.get("proxyoverride")).toBe("localhost;127.*;10.*;172.16.*;192.168.*;<local>");
  expect(values.get("user agent")).toBe("Mozilla/4.0 (compatible; MSIE 8.0; Win32)");
  expect(values.has("5.0")).toBe(false);
  expect(parseRegQuery("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
});

// The updater's own cases (updates.rs): what Clash for Windows / v2rayN write, and the bypass list
// Windows ships with.
test("the Windows proxy is the https one, unless switched off, SOCKS-only or bypassed", () => {
  const overrides = "localhost;127.*;10.*;172.16.*;192.168.*;*.corp.example;<local>";
  const win = (host: string, enabled: boolean, server: string) => proxyFromWindowsSettings(host, enabled, server, overrides);
  const proxy = "http://127.0.0.1:7890";
  expect(win("api.anthropic.com", true, "127.0.0.1:7890")).toBe(proxy);
  expect(win("api.anthropic.com", false, "127.0.0.1:7890")).toBeNull();
  expect(win("api.anthropic.com", true, "")).toBeNull();
  // Per protocol: https wins, http serves when it is the only one, socks alone is none.
  expect(win("api.anthropic.com", true, "http=127.0.0.1:1;https=127.0.0.1:7890;socks=127.0.0.1:7891")).toBe(proxy);
  expect(win("api.anthropic.com", true, "http=127.0.0.1:7890")).toBe(proxy);
  expect(win("api.anthropic.com", true, "socks=127.0.0.1:7891")).toBeNull();
  // A scheme already on the address is kept; a non-HTTP one is not a proxy Claude Code can use.
  expect(win("api.anthropic.com", true, "http://127.0.0.1:7890")).toBe(proxy);
  expect(win("api.anthropic.com", true, "socks5://127.0.0.1:7891")).toBeNull();
  // The bypass list: exact names, wildcards on either side, and <local> for dotless names.
  expect(win("localhost", true, "127.0.0.1:7890")).toBeNull();
  expect(win("192.168.1.20", true, "127.0.0.1:7890")).toBeNull();
  expect(win("build.corp.example", true, "127.0.0.1:7890")).toBeNull();
  expect(win("printer", true, "127.0.0.1:7890")).toBeNull();
  expect(win("API.Anthropic.com.", true, "127.0.0.1:7890")).toBe(proxy);
  expect(win("corp.example.anthropic.com", true, "127.0.0.1:7890")).toBe(proxy);
});

test("on Windows a proxy variable counts however its name is cased, and so does NO_PROXY", async () => {
  expect(await claudeProxy({ Https_Proxy: "http://10.0.0.2:8080" }, never, "win32")).toEqual({ url: "http://10.0.0.2:8080", source: "env" });
  expect(await claudeProxy({ All_Proxy: "http://10.0.0.2:8080" }, never, "win32")).toEqual({ url: "http://10.0.0.2:8080", source: "env" });
  expect(await claudeProxy({ No_Proxy: "*" }, never, "win32")).toBeNull();
  expect(await claudeProxy({}, async () => "http://127.0.0.1:7890", "win32")).toEqual({ url: "http://127.0.0.1:7890", source: "system" });
  const env = { Path: "C:\\Windows", No_Proxy: "intranet" };
  expect(withSystemProxy(env, { proxy: "http://127.0.0.1:7890", proxy_source: "system" }, "win32"))
    .toEqual({ ...env, HTTPS_PROXY: "http://127.0.0.1:7890" });
});
