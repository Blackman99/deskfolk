/**
 * Deskfolk on a phone: the same app as `App.tsx`, built for the web and served from the relay
 * (`nsh package Hosted.tsx --target web`). The hosted switch goes in first, before any of the
 * messenger's modules is evaluated; the device then pairs with the Mac through the relay and runs
 * on the encrypted remote client. ADR 0107, Phase 1c.
 */
import "./src/platform/hosted";
import "./App";
