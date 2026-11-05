<script lang="ts">
  import { onMount } from 'svelte';
  import { HOME } from '$lib/home/copy';
  import { INITIAL, reduce, type RemoteAction } from '$lib/home/remote-channel';
  import PhoneUI from '$lib/home/scenes/PhoneUI.svelte';
  import { openRemoteLink, type RemoteLink } from '$lib/home/scenes/remote/channel';

  /**
   * The pop-up phone: the home page's remote demo in its own window. What you tap here is applied
   * here and sent to the page, which applies it too and sends its state back.
   */
  let { data } = $props();
  const copy = $derived(HOME[data.lang].scenes.remote);

  let remote = $state.raw(INITIAL);
  let link: RemoteLink | null = null;

  function send(action: RemoteAction) {
    remote = reduce(remote, action);
    link?.send({ type: 'action', action });
  }

  onMount(() => {
    link = openRemoteLink((m) => {
      if (m.type === 'action') remote = reduce(remote, m.action);
      else if (m.type === 'state') remote = m.state;
    });
    link?.send({ type: 'hello' });
    return () => link?.close();
  });
</script>

<svelte:head>
  <meta name="robots" content="noindex" />
  <title>Deskfolk · {copy.tabs[0]}</title>
</svelte:head>

<main>
  <PhoneUI {copy} state={remote} lang={data.lang} {send} framed={false} />
</main>

<style>
  main {
    height: 100dvh;
    max-width: 520px;
    margin: 0 auto;
    background: var(--paper);
  }
</style>
