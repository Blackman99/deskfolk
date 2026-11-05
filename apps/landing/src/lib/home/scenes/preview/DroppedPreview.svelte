<script lang="ts">
  import type { SceneCopy } from '../../copy';
  import type { Shown } from './dropped';

  /**
   * The file the reader dropped, shown as its kind asks. Text goes in a <pre> as text; Markdown and
   * HTML go only into iframes with an empty sandbox (no scripts, no same-origin); nothing is ever
   * written into the page as markup.
   */
  let { shown, copy }: { shown: Shown; copy: SceneCopy['preview'] } = $props();
</script>

<div class="drop">
  {#if shown.kind === 'image' && shown.url}
    <img class="media" src={shown.url} alt={shown.name} />
  {:else if shown.kind === 'video' && shown.url}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="media" src={shown.url} controls playsinline aria-label={shown.name}></video>
  {:else if shown.kind === 'audio' && shown.url}
    <div class="audio"><audio src={shown.url} controls aria-label={shown.name}></audio></div>
  {:else if shown.kind === 'pdf' && shown.url}
    <iframe class="frame" src={shown.url} title={shown.name}></iframe>
  {:else if (shown.kind === 'markdown' || shown.kind === 'html') && shown.srcdoc !== null}
    <iframe class="frame" sandbox="" srcdoc={shown.srcdoc} title={shown.name}></iframe>
  {:else if shown.kind === 'text'}
    <pre class="code">{shown.text}</pre>
  {:else if shown.kind === 'office'}
    <p class="card">{copy.office(shown.ext.toUpperCase())}</p>
  {:else}
    <p class="card">{copy.unknown}</p>
  {/if}
  {#if shown.truncated}<span class="cut">{copy.tooBig(200)}</span>{/if}
</div>

<style>
  .drop {
    position: relative;
    height: 100%;
    background: var(--paper);
  }

  .media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--ground-2);
  }

  .audio {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 16px;
  }

  .audio audio {
    width: 100%;
  }

  .frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  .code {
    margin: 0;
    height: 100%;
    overflow: auto;
    padding: 12px 14px;
    font: 12px/1.55 var(--font-mono);
    color: var(--ink);
    white-space: pre;
    tab-size: 2;
  }

  .card {
    margin: 0;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    text-align: center;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink-2);
  }

  .cut {
    position: absolute;
    left: 8px;
    bottom: 8px;
    padding: 3px 9px;
    font-size: 11.5px;
    border-radius: var(--radius-full);
    background: var(--paper);
    color: var(--ink-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-float);
  }
</style>
