/**
 * The settings dialog's tabs as data (`settings/SettingsNav.svelte` wrote each as markup): which
 * exist for this window, in what order, with their icon, name and what rides on the right.
 */
import type { IconName } from "../Icon";
import type { Copy } from "../../m/copy.ts";

export type SettingsTab = "general" | "behavior" | "interface" | "models" | "agents" | "mcp" | "prompts" | "notifications" | "lessons" | "remote" | "about";

/** What rides on a tab's right: an error mark, a number (`warn` in the warning colour), or the update dot. */
export type TabBadge = { kind: "error" } | { kind: "count"; value: number; warn?: boolean } | { kind: "dot" };

export type NavTab = { id: SettingsTab; icon: IconName; label: string; badge: TabBadge | null };

export type NavFacts = {
  providers: number;
  mcpServers: number;
  generalHasError: boolean;
  modelsHasError: boolean;
  promptCounts: { edited: number; conflict: boolean };
  lessonsTabVisible: boolean;
  remoteTabVisible: boolean;
  behaviorTabVisible: boolean;
  interfaceTabVisible: boolean;
  updateVisible: boolean;
};

export function navTabs(t: Copy, f: NavFacts): NavTab[] {
  const count = (value: number, warn = false): TabBadge | null => (value > 0 ? { kind: "count", value, warn } : null);
  const tabs: (NavTab | null)[] = [
    { id: "general", icon: "settings", label: t.settings.tabGeneral, badge: f.generalHasError ? { kind: "error" } : null },
    f.behaviorTabVisible ? { id: "behavior", icon: "layout", label: t.settings.tabBehavior, badge: null } : null,
    f.interfaceTabVisible ? { id: "interface", icon: "sliders", label: t.ui.tab, badge: null } : null,
    { id: "models", icon: "box", label: t.settings.tabModels, badge: f.modelsHasError ? { kind: "error" } : count(f.providers) },
    { id: "agents", icon: "terminal-square", label: t.settings.tabAgents, badge: null },
    { id: "mcp", icon: "server", label: t.settings.tabMcp, badge: count(f.mcpServers) },
    { id: "prompts", icon: "type", label: t.settings.tabPrompts, badge: count(f.promptCounts.edited, f.promptCounts.conflict) },
    { id: "notifications", icon: "bell", label: t.settings.tabNotifications, badge: null },
    f.lessonsTabVisible ? { id: "lessons", icon: "book-open", label: t.settings.tabLessons, badge: null } : null,
    f.remoteTabVisible ? { id: "remote", icon: "smartphone", label: t.settings.tabRemote, badge: null } : null,
    { id: "about", icon: "info", label: t.settings.tabAbout, badge: f.updateVisible ? { kind: "dot" } : null },
  ];
  return tabs.filter((tab): tab is NavTab => tab !== null);
}
