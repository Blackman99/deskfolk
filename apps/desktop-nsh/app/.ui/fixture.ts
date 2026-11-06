/**
 * What `scripts/ui-tests.ts` seeded and how to open the app on its runtime: a desktop window whose
 * shell answers the Tauri commands the runtime asks first.
 */
import { open, type OpenOptions } from "nsh/test";
import fixture from "./.fixture.json";

export const seeded = fixture as {
  origin: string;
  token: string;
  writerDirect: string;
  editorDirect: string;
  group: string;
  workspace: string;
};

export function openApp(options: Partial<OpenOptions> = {}) {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  return open("../App.tsx", {
    platform: "macos",
    width: 1100,
    height: 760,
    locale: "zh-CN",
    network: "live",
    ...options,
    host: {
      params: { ...endpoint, windowId: 1, material: "none" },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
      },
    },
  });
}
