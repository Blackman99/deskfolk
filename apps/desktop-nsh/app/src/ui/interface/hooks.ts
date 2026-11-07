/**
 * A hook (ADR 0108 decision 7): a main part of the app by its name in `UI_HOOKS`, written on that
 * part's view as `class={ui("composer", "flex-col …")}`. It gives back the app's own classes; with
 * the profile's `classes` layer (milestone 2) the classes the profile sets for the hook follow them,
 * so they win their ties. Not `testID` (the tests own it, one per view) and not `nativeID` (it does
 * nothing on plain views in NSH 0.4).
 */
import type { UiHook } from "@real-bot/protocol";

export function ui(hook: UiHook, own = ""): string {
  void hook;
  return own;
}
