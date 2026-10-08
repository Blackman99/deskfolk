/**
 * The state every save-as-you-type page keeps: the debounce timer, whether a save is in flight,
 * and how many have landed. What is saved, and what a flush sends, stays with the page.
 */
export class Autosave {
  /** A save is in flight. */
  saving = $state(false);
  /** Saves that have landed since the page opened; the page resets it to 0 when it opens another item. */
  savedTick = $state(0);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Runs `run` once typing has been quiet for `delay`; another call before then restarts the wait. */
  schedule(run: () => void, delay = 600): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delay);
  }

  /** Drops a waiting save, e.g. before sending its draft now. Says whether one was waiting. */
  cancel(): boolean {
    if (!this.timer) return false;
    clearTimeout(this.timer);
    this.timer = null;
    return true;
  }
}
