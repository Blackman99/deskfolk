<script lang="ts">
  let {
    src,
    width,
    height,
    title,
    badge,
    description,
    closeLabel,
    ground,
    loop = false
  }: {
    src: string;
    /** The video's own size: the frame keeps its shape and never grows past it. */
    width: number;
    height: number;
    title: string;
    /** Beside the title, such as the film's length. */
    badge?: string;
    description?: string;
    closeLabel: string;
    /** Behind the video until its first frame arrives. */
    ground: string;
    /** A walkthrough step's clip: silent, round and round. */
    loop?: boolean;
  } = $props();

  const id = $props.id();

  let dialog: HTMLDialogElement | undefined = $state();
  let video: HTMLVideoElement | undefined = $state();
  /** Focus goes back here on close; WebKit does not do it for a dialog. */
  let opener: HTMLElement | null = null;

  /** Call it from a click: the video loads only now, and may start with its sound on. */
  export function open() {
    if (!dialog || !video || dialog.open) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    video.muted = loop;
    if (loop) video.currentTime = 0;
    // Refused (a phone saving power): the controls' play button starts it.
    video.play().catch(() => {});
  }

  function close() {
    dialog?.close();
  }

  function onclose() {
    video?.pause();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }
</script>

<dialog
  bind:this={dialog}
  class="video-dialog"
  aria-labelledby="{id}-title"
  aria-describedby={description ? `${id}-desc` : undefined}
  style:--ar="{width} / {height}"
  style:--max-w="{width}px"
  {onclose}
  onclick={(e) => {
    // Only the backdrop and the gutter around the frame are the dialog itself.
    if (e.target === dialog) close();
  }}
>
  <div class="frame">
    <header class="head">
      <div class="head-copy">
        <h2 id="{id}-title" class="serif">
          {title}
          {#if badge}<span class="badge mono">{badge}</span>{/if}
        </h2>
        {#if description}<p id="{id}-desc">{description}</p>{/if}
      </div>
      <button type="button" class="close" aria-label={closeLabel} title={closeLabel} onclick={close}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </header>
    <!-- The film's soundtrack is music and effects only, the clips are silent; the words are in the picture. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      {src}
      preload="none"
      controls
      playsinline
      {loop}
      style:background={ground}
    ></video>
  </div>
</dialog>

<style>
  /* The page behind stays where it was: no scrolling the walkthrough on to another step. */
  :global(html:has(dialog.video-dialog[open])) {
    overflow: hidden;
  }

  .video-dialog {
    --head-h: 88px;
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--gutter);
    border: 0;
    background: transparent;
    color: #fff;
    overflow: hidden;
  }

  .video-dialog[open] {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-dialog::backdrop {
    background: rgba(8, 12, 20, 0.84);
  }

  /* As wide as fits the viewport and, below the header, its height; never past the video's own size. */
  .frame {
    width: min(var(--max-w), 100%, calc((100dvh - 2 * var(--gutter) - var(--head-h)) * var(--ar)));
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .head-copy {
    min-width: 0;
  }

  h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.35;
  }

  .badge {
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 6px;
    padding: 1px 7px;
  }

  .head p {
    margin: 4px 0 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.72);
  }

  .close {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    cursor: pointer;
    transition: background-color 160ms ease, border-color 160ms ease;
  }

  .close:hover {
    background: rgba(255, 255, 255, 0.18);
    border-color: rgba(255, 255, 255, 0.32);
  }

  video {
    display: block;
    width: 100%;
    aspect-ratio: var(--ar);
    border-radius: 12px;
    box-shadow: 0 30px 80px -24px rgba(0, 0, 0, 0.7);
  }

  .video-dialog[open]::backdrop {
    animation: video-fade 200ms ease-out;
  }

  .video-dialog[open] .frame {
    animation: video-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @keyframes video-fade {
    from { opacity: 0; }
  }

  @keyframes video-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
  }

  /* A phone on its side: the video gets the height the description would take. */
  @media (max-height: 520px) {
    .video-dialog {
      --head-h: 52px;
    }

    .head p {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .video-dialog[open]::backdrop,
    .video-dialog[open] .frame {
      animation: none;
    }
  }
</style>
