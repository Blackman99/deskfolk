<script lang="ts">
  let {
    text,
    label,
    doneLabel,
    compact = false
  }: { text: string; label: string; doneLabel: string; compact?: boolean } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy() {
    navigator.clipboard?.writeText(text).then(() => {
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1800);
    });
  }
</script>

<button class="copy" class:compact type="button" onclick={copy} aria-live="polite">
  {copied ? doneLabel : label}
</button>

<style>
  .copy {
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    min-height: 32px;
    color: var(--ink-2);
    background: var(--ground);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
  }

  .copy:hover {
    color: var(--teal-2);
    border-color: var(--teal-line);
  }

  .copy.compact {
    min-height: 28px;
    padding: 2px 9px;
    font-size: 12px;
  }
</style>
