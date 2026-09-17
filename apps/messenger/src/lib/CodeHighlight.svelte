<script lang="ts">
	import type { HighlightLang } from './highlight-lang.ts';
	import { bindCssHighlight } from './highlight-mount.ts';
	import type { CssHighlightHandle } from './css-highlight.ts';

	interface Props {
		code: string;
		lang: HighlightLang;
		editable?: boolean;
	}

	let { code, lang, editable = false }: Props = $props();
	let el = $state<HTMLElement | null>(null);

	$effect(() => {
		const host = el;
		const source = code;
		const language = lang;
		const live = editable;
		if (!host) return;
		host.textContent = source;
		let handle: CssHighlightHandle | null = null;
		let cancelled = false;
		void bindCssHighlight(host, language, { watch: live }).then((next) => {
			if (cancelled) {
				next?.dispose();
				return;
			}
			handle = next;
		});
		return () => {
			cancelled = true;
			handle?.dispose();
		};
	});
</script>

<pre
	class="code-hl"
	class:is-editable={editable}
	bind:this={el}
	contenteditable={editable ? 'plaintext-only' : undefined}
	spellcheck="false"
	translate="no"
></pre>
