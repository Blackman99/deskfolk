/** The screens `Story.tsx` can open on their own, by name. Each module's default export is the view. */
import type { JSX } from "nsh";

type Story = () => Promise<{ default: () => JSX.Element }>;

export const stories: Record<string, Story> = {
  kit: () => import("./kit"),
  "kit-forms": () => import("./kit-forms"),
  "kit-identity": () => import("./kit-identity"),
  shared: () => import("./shared"),
  "settings-base": () => import("./settings-base"),
};
