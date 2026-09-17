<script lang="ts">
  import { generateBoringAvatar } from '@real-bot/protocol';

  let { name, size = 28 }: { name: string; size?: number } = $props();

  const svg = $derived(generateBoringAvatar({ name, variant: 'beam', size: 80 }));
</script>

<span class="avatar" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  {@html svg}
</span>

<style>
  .avatar {
    display: inline-block;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    background: var(--line, #e2e8f0);
    line-height: 0;
  }

  .avatar :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
