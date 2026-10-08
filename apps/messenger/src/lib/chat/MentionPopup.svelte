<script lang="ts">
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { ComposerMentions } from './composer-mentions.svelte.ts';

	type Props = {
		mentions: ComposerMentions;
		t: Copy;
	};

	let { mentions, t }: Props = $props();
</script>

<div
	bind:this={mentions.mentionPopupEl}
	class="mention-autocomplete-popup"
	role="listbox"
	tabindex="-1"
	onmousedown={(e) => e.preventDefault()}
>
	<div class="autocomplete-header text-11 font-semibold uppercase text-muted pt-3 px-5 pb-2 tracking-[0.04em]">{t.chat.mentionTooltip}</div>
	{#each mentions.mentionCandidates as cand, idx (cand.id)}
		{@const pal = !cand.isEveryone ? botAvatarColor(cand.id) : null}
		<button
			type="button"
			role="option"
			aria-selected={idx === mentions.mentionHighlightIndex}
			class="autocomplete-item"
			class:is-highlighted={idx === mentions.mentionHighlightIndex}
			onclick={() => mentions.selectMentionCandidate(cand)}
			onmouseenter={() => (mentions.mentionHighlightIndex = idx)}
		>
			{#if cand.isEveryone}
				<span class="autocomplete-avatar is-everyone">👥</span>
			{:else if cand.avatar && avatarSrc(cand.avatar)}
				<img src={avatarSrc(cand.avatar)} alt="" class="autocomplete-avatar-img w-13 h-13 rounded-[50%] object-cover shrink-0" />
			{:else if pal}
				<span class="autocomplete-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border}">
					{rosterLetter(cand.name)}
				</span>
			{/if}
			<div class="autocomplete-info flex flex-col min-w-0 flex-1">
				<span class="autocomplete-name text-13 font-semibold text-ink">@{cand.name}</span>
				{#if cand.duties}
					<span class="autocomplete-desc text-11 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{cand.duties}</span>
				{/if}
			</div>
		</button>
	{/each}
</div>

<style>
	/* Mention Autocomplete Popup */
	.mention-autocomplete-popup {
		position: absolute;
		bottom: calc(100% - 6px);
		left: max(24px, calc(50% - (var(--chat-max-width) / 2)));
		width: min(380px, calc(100% - 48px));
		max-height: 240px;
		overflow-y: auto;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px rgba(18, 28, 32, 0.12), 0 1px 3px rgba(18, 28, 32, 0.08);
		padding: 6px;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 2px;
		pointer-events: auto;
	}

	.autocomplete-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		border: none;
		background: transparent;
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.autocomplete-item:hover,
	.autocomplete-item.is-highlighted {
		background: var(--accent-tint);
	}

	.autocomplete-avatar {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		flex-shrink: 0;
		border: 1px solid var(--line);
	}

	.autocomplete-avatar.is-everyone {
		background: var(--chip);
		font-size: 14px;
	}

	@container conversation (max-width: 680px) {
		/* Clear of the bar's top edge, which it used to overlap by the card's rounding. */
		.mention-autocomplete-popup {
			bottom: calc(100% + 6px);
			left: 10px;
			width: calc(100% - 20px);
		}

		@media (pointer: coarse) {
			.mention-autocomplete-popup {
				left: 16px;
				width: calc(100% - 32px);
			}
		}
	}
</style>
