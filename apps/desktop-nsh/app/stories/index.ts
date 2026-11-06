/** The screens `Story.tsx` can open on their own, by name. Each module's default export is the view. */
import type { JSX } from "nsh";

type Story = () => Promise<{ default: () => JSX.Element }>;

export const stories: Record<string, Story> = {
  kit: () => import("./kit"),
  "kit-forms": () => import("./kit-forms"),
  "kit-identity": () => import("./kit-identity"),
  shared: () => import("./shared"),
  "settings-base": () => import("./settings-base"),
  plan: () => import("./plan"),
  "panels-a": () => import("./panels-a"),
  "chat-cards": () => import("./chat-cards"),
  "chat-media": () => import("./chat-media"),
  "chat-composer": () => import("./chat-composer"),
  usage: () => import("./usage"),
  "chat-header": () => import("./chat-header"),
  trace: () => import("./trace"),
  annotations: () => import("./annotations"),
  platform: () => import("./platform"),
  "spend-a": () => import("./spend-a"),
  "settings-remote-ui": () => import("./settings-remote-ui"),
  "settings-providers": () => import("./settings-providers"),
  "sidebar-rail": () => import("./sidebar-rail"),
  "settings-general": () => import("./settings-general"),
  "settings-prompts": () => import("./settings-prompts"),
};
