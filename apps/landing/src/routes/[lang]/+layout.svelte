<script lang="ts">
  import SiteFrame from '$lib/SiteFrame.svelte';

  let { data, children } = $props();
</script>

<SiteFrame lang={data.lang}>
  {@render children()}
</SiteFrame>
