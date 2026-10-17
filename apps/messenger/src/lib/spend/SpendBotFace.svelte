<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import { avatarSrc, botAvatarColor, isFolkAvatar } from '../avatar.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';

	/**
	 * A Bot's face beside its figures. The roster gives the picture; a Bot gone from it (deleted)
	 * keeps the first letter of the name the ledger kept, greyed. No Bot at all is a dashed blank.
	 */
	interface Props {
		id: string | null;
		/** The name the ledger kept, for a Bot the roster no longer has. */
		name?: string | null;
		bot?: Bot | null;
		size?: number;
	}

	let { id, name = null, bot = null, size = 22 }: Props = $props();

	const src = $derived(avatarSrc(bot?.avatar));
	const folk = $derived(isFolkAvatar(bot?.avatar));
	const palette = $derived(id ? botAvatarColor(id) : null);
	let failed = $state<string | null>(null);
</script>

<span
	class="bot-face"
	class:is-folk={folk && src && failed !== src}
	class:is-gone={id != null && !bot}
	class:is-none={id == null}
	style:width="{size}px"
	style:height="{size}px"
	style:font-size="{Math.round(size * 0.5)}px"
	style:background={bot && !folk && palette ? palette.bg : undefined}
	style:color={bot && palette ? palette.text : undefined}
	aria-hidden="true"
>
	{#if src && failed !== src}
		<img {src} alt="" onerror={() => (failed = src)} />
	{:else if id != null}
		{rosterLetter(bot?.name ?? name ?? '')}
	{/if}
</span>

<style>
	.bot-face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		overflow: hidden;
		border-radius: 30%;
		font-weight: 650;
		line-height: 1;
		background: var(--line-subtle);
		color: var(--muted);
	}

	.bot-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.bot-face.is-folk {
		background: transparent;
		overflow: visible;
	}

	.bot-face.is-gone {
		opacity: 0.7;
	}

	.bot-face.is-none {
		background: transparent;
		border: 1px dashed var(--line);
	}
</style>
