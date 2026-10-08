/**
 * The independent-runtime switch on the General tab and the confirm it raises, lifted out of
 * `SettingsModal.svelte`. The modal constructs it, so the status and an open confirm outlive a tab
 * switch; it takes getters for what it reads from that instance, the way `ShellDangerConfirm` does.
 */
import type { Copy } from "../copy.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { gatedIndependentStatus, invokeIndependentRuntime, type IndependentStatus } from "./independent-runtime.ts";

export type IndependentRuntimeDeps = {
  runtime: () => MessengerRuntime;
  t: () => Copy;
  /** The shell's bindable `confirmingIndependent`, so neither backdrop closes under the confirm. */
  setConfirmingIndependent: (value: boolean) => void;
};

export class IndependentRuntimeController {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getT: () => Copy;
  private readonly setConfirmingIndependent: (value: boolean) => void;

  independent = $state<IndependentStatus>(gatedIndependentStatus("g_pack_not_verified"));
  independentBusy = $state(false);
  independentConfirm = $state<"enable" | "disable" | null>(null);

  constructor(deps: IndependentRuntimeDeps) {
    this.getRuntime = deps.runtime;
    this.getT = deps.t;
    this.setConfirmingIndependent = deps.setConfirmingIndependent;

    $effect(() => {
      this.setConfirmingIndependent(this.independentConfirm !== null);
    });
    $effect(() => {
      if (!this.getRuntime().settingsOpen) {
        this.independentConfirm = null;
        return;
      }
      void this.refreshIndependent();
    });
  }

  async refreshIndependent(): Promise<void> {
    this.independent = await invokeIndependentRuntime("status");
  }

  independentReason(status: IndependentStatus): string {
    const t = this.getT();
    if (status.diagnostic === "dev_does_not_install_agent") return t.settings.independentRuntimeDev;
    if (status.diagnostic === "browser_cannot_install_agent") return t.settings.independentRuntimeBrowser;
    if (status.error === "bootstrap failed" || status.error === "port_not_empty") return t.settings.independentRuntimeFailed;
    return t.settings.independentRuntimeGated;
  }

  requestIndependent(next: boolean): void {
    if (this.independentBusy) return;
    this.independentConfirm = next ? "enable" : "disable";
  }

  async confirmIndependent(): Promise<void> {
    const action = this.independentConfirm;
    if (!action) return;
    this.independentBusy = true;
    try {
      this.independent = await invokeIndependentRuntime(action);
      if (this.independent.drain.phase === "draining") return;
      this.independentConfirm = null;
    } finally {
      this.independentBusy = false;
    }
  }

  async waitIndependent(): Promise<void> {
    this.independentBusy = true;
    try {
      this.independent = await invokeIndependentRuntime("wait");
      if (this.independent.drain.phase !== "draining") this.independentConfirm = null;
    } finally {
      this.independentBusy = false;
    }
  }

  async forceIndependent(): Promise<void> {
    this.independentBusy = true;
    try {
      this.independent = await invokeIndependentRuntime("force");
      if (this.independent.drain.phase !== "draining") this.independentConfirm = null;
    } finally {
      this.independentBusy = false;
    }
  }

  async cancelIndependent(): Promise<void> {
    this.independentBusy = true;
    try {
      this.independent = await invokeIndependentRuntime("cancel");
      this.independentConfirm = null;
    } finally {
      this.independentBusy = false;
    }
  }
}
