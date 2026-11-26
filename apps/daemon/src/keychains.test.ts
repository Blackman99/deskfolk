import { expect, test } from "bun:test";
import { asksKeychainForAgentSecret, asksKeychainForSecret, isKeychainPath } from "./keychains";

test("the macOS keychains are off limits on a Mac", () => {
  expect(isKeychainPath("/Users/me/Library/Keychains/login.keychain-db", "/Users/me", "darwin")).toBe(true);
  expect(isKeychainPath("/Library/Keychains/System.keychain", "/Users/me", "darwin")).toBe(true);
  expect(isKeychainPath("/Users/me/Library/Preferences/x.plist", "/Users/me", "darwin")).toBe(false);
  expect(asksKeychainForSecret("security find-generic-password -s x -w", "darwin")).toBe(true);
  expect(asksKeychainForSecret("security list-keychains", "darwin")).toBe(false);
});

test("GNOME Keyring's and KWallet's files are off limits on Linux, and nothing else nearby", () => {
  const home = "/home/me";
  for (const path of [
    "/home/me/.local/share/keyrings/login.keyring",
    "/home/me/.local/share/keyrings",
    "/home/me/.local/share/kwalletd/kdewallet.kwl",
    "/home/me/.kde/share/apps/kwallet/kdewallet.kwl",
    "/home/me/.kde4/share/apps/kwallet",
  ]) {
    expect(isKeychainPath(path, home, "linux")).toBe(true);
  }
  expect(isKeychainPath("/home/me/.local/share/keyrings-backup/x", home, "linux")).toBe(false);
  expect(isKeychainPath("/home/me/.local/share/real-bot/state.db", home, "linux")).toBe(false);
  // The Linux folders mean nothing on a Mac.
  expect(isKeychainPath("/Users/me/.local/share/keyrings/login.keyring", "/Users/me", "darwin")).toBe(false);
});

test("asking the Linux keyring for a secret is refused, by tool or over D-Bus", () => {
  for (const command of [
    "secret-tool lookup service real-bot",
    "secret-tool search --all service x",
    "kwallet-query -r key kdewallet",
    "gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SearchItems {}",
    "busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service OpenSession sv plain s ''",
    "qdbus org.kde.kwalletd5 /modules/kwalletd5",
    "python3 -c 'import secretstorage; bus=1' # org.freedesktop.secrets",
  ]) {
    expect(asksKeychainForSecret(command, "linux")).toBe(true);
  }
  expect(asksKeychainForSecret("secret-tool store --label=x service y", "linux")).toBe(false);
  expect(asksKeychainForSecret("ls ~/.local/share", "linux")).toBe(false);
  // Still the macOS rule on Linux too, as before.
  expect(asksKeychainForSecret("security find-generic-password -w", "linux")).toBe(true);
  // And the Linux one does not reach a Mac or Windows.
  expect(asksKeychainForSecret("secret-tool lookup service x", "darwin")).toBe(false);
  expect(asksKeychainForSecret("secret-tool lookup service x", "win32")).toBe(false);
});

test("an agent checked as it runs is refused only what signs an agent in or holds the app's keys, by the item's name", () => {
  for (const command of [
    // As agy ran them on 2026-11-26, each stopping a project session's turn: the test account it was
    // given to keep, read back for a script in its own notes; then the tool's own help.
    `ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD="$(security find-generic-password -w -s 'shop-admin-test' -a 'admin@example.com')" python3 /Users/me/.gemini/antigravity-cli/brain/d42bbf10/scratch/e2e_verify_test.py`,
    `security find-generic-password -h 2>&1 ; echo "---" ; ps aux | grep -E "real-bot|dev-runtime|deskfolk" | grep -v grep || true`,
    "security find-internet-password -s staging.example.com -a deploy -w",
    "security find-generic-password -a \"$USER\" -s notarytool-profile -g",
    "security add-generic-password -U -s shop-admin-test -a admin@example.com -w \"$PASS\"",
    "security list-keychains",
    "security find-identity -v -p codesigning",
    // A name by itself asks nothing.
    "rg -n 'Claude Code-credentials' docs/",
  ]) {
    expect([command, asksKeychainForAgentSecret(command, "darwin")]).toEqual([command, false]);
  }
  for (const command of [
    "security find-generic-password -s 'Claude Code-credentials' -w",
    // An account's config directory has its own item, the name ending in a hash.
    "security find-generic-password -s \"Claude Code-credentials-1a2b3c4d\" -w",
    "security find-generic-password -s Claude\\ Code-credentials -g",
    "security find-generic-password -l 'claude code-credentials'",
    "security find-generic-password -s com.real-bot.daemon -a credentials -w",
    "security find-generic-password -s 'Codex MCP Credentials' -w",
    // The name in a variable the ask is built from.
    "SVC='Codex Auth'; security find-generic-password -s \"$SVC\" -w",
    // All the keychain holds, theirs with the rest.
    "security dump-keychain -d login.keychain-db",
    "security dump-keychain | grep shop",
    "security export -k login.keychain-db -t identities -o /tmp/x.p12",
  ]) {
    expect([command, asksKeychainForAgentSecret(command, "darwin")]).toEqual([command, true]);
  }
  // Windows has no keychain to ask this way.
  expect(asksKeychainForAgentSecret("security find-generic-password -s 'Claude Code-credentials' -w", "win32")).toBe(false);
});

test("the same of the Linux keyring: a lookup by name, and whatever could hand over any item", () => {
  expect(asksKeychainForAgentSecret("secret-tool lookup service shop-admin-test account admin@example.com", "linux")).toBe(false);
  expect(asksKeychainForAgentSecret("secret-tool store --label=x service shop-admin-test account a", "linux")).toBe(false);
  for (const command of [
    "secret-tool lookup service com.real-bot.daemon account credentials",
    "secret-tool lookup service 'Codex Auth' account cli",
    "secret-tool search --all service shop-admin-test",
    "kwallet-query -r key kdewallet",
    "gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SearchItems {}",
    "qdbus org.kde.kwalletd5 /modules/kwalletd5",
    "security find-generic-password -s 'Claude Code-credentials' -w",
  ]) {
    expect([command, asksKeychainForAgentSecret(command, "linux")]).toEqual([command, true]);
  }
  // The Linux tools mean nothing on a Mac.
  expect(asksKeychainForAgentSecret("secret-tool lookup service com.real-bot.daemon account credentials", "darwin")).toBe(false);
});
