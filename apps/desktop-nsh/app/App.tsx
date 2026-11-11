/**
 * Deskfolk on NSH. The browser globals and the Tauri bridge go in first, the device's storage is
 * read, and only then do the messenger's modules load (some read `localStorage` as they load).
 */
import "./src/platform/install";
import { mount } from "nsh";
import { loadStorage } from "./src/platform/globals";

void loadStorage()
  .then(() => import("./src/Main"))
  .then(({ Main }) => mount(Main));
