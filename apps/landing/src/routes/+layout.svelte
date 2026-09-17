<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<svelte:head>
  <title>Real Bot — Your Persistent Local AI Team on macOS</title>
  <meta name="description" content="A local-first macOS multi-agent collaboration application with persistent teammates, shared local workspace, open model endpoints and MCP tools." />
</svelte:head>

{@render children()}
