import { expect, test } from "bun:test";
import { asksKeychainForSecret, isKeychainPath } from "./keychains";

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
