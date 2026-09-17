<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import type { ReplyingEntry } from './transcript.ts';
	import { botAvatarColor } from './chat-view.ts';
	import { rosterLetter } from './roster-letter.ts';
	import { avatarSrc } from './avatar.ts';

	interface Props {
		entries: readonly ReplyingEntry[];
		botsById: Map<string, Bot>;
		isUser?: boolean;
		thinkingText: string;
		deletedText?: string;
		onOpenProfile?: (botId: string) => void;
	}

	let {
		entries,
		botsById,
		isUser = false,
		thinkingText,
		deletedText = '?',
		onOpenProfile
	}: Props = $props();
</script>

{#if entries && entries.length > 0}
	{#if entries.length === 1}
		{@const entry = entries[0]}
		{@const replyBot = botsById.get(entry.bot_id)}
		{@const pal = botAvatarColor(entry.bot_id)}
		<div class="attached-replying-card is-single" class:is-user={isUser}>
			{#if onOpenProfile && replyBot}
				<button
					type="button"
					class="attached-replying-chip is-clickable"
					onclick={() => onOpenProfile(entry.bot_id)}
					title={replyBot.name}
				>
					<div
						class="attached-replying-avatar"
						style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
					>
						{#if avatarSrc(replyBot.avatar)}
							<img src={avatarSrc(replyBot.avatar)} alt="" class="avatar-img" />
						{:else}
							{rosterLetter(replyBot.name)}
						{/if}
					</div>
					<span class="attached-replying-name">{replyBot.name}</span>
				</button>
			{:else}
				<div class="attached-replying-chip">
					<div
						class="attached-replying-avatar"
						style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
						title={replyBot?.name ?? deletedText}
					>
						{#if avatarSrc(replyBot?.avatar)}
							<img src={avatarSrc(replyBot?.avatar)} alt="" class="avatar-img" />
						{:else}
							{rosterLetter(replyBot?.name ?? '?')}
						{/if}
					</div>
					<span class="attached-replying-name">{replyBot?.name ?? deletedText}</span>
				</div>
			{/if}
			<span class="attached-replying-dots" aria-hidden="true">
				<span class="replying-dot"></span>
				<span class="replying-dot"></span>
				<span class="replying-dot"></span>
			</span>
			<span class="attached-replying-text">{thinkingText}</span>
		</div>
	{:else}
		<div class="attached-replying-card is-multiple" class:is-user={isUser}>
			<div class="attached-replying-header">
				<span class="attached-replying-dots" aria-hidden="true">
					<span class="replying-dot"></span>
					<span class="replying-dot"></span>
					<span class="replying-dot"></span>
				</span>
				<span class="attached-replying-title">{thinkingText}</span>
				<span class="attached-replying-count mono">{entries.length}</span>
			</div>
			<div class="attached-replying-roster">
				{#each entries as entry (entry.turn_id ?? entry.judgement_id ?? entry.bot_id)}
					{@const replyBot = botsById.get(entry.bot_id)}
					{@const pal = botAvatarColor(entry.bot_id)}
					{#if onOpenProfile && replyBot}
						<button
							type="button"
							class="attached-replying-chip is-clickable"
							onclick={() => onOpenProfile(entry.bot_id)}
							title={replyBot.name}
						>
							<div
								class="attached-replying-avatar"
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
							>
								{#if avatarSrc(replyBot.avatar)}
									<img src={avatarSrc(replyBot.avatar)} alt="" class="avatar-img" />
								{:else}
									{rosterLetter(replyBot.name)}
								{/if}
							</div>
							<span class="attached-replying-name">{replyBot.name}</span>
						</button>
					{:else}
						<div class="attached-replying-chip">
							<div
								class="attached-replying-avatar"
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
								title={replyBot?.name ?? deletedText}
							>
								{#if avatarSrc(replyBot?.avatar)}
									<img src={avatarSrc(replyBot?.avatar)} alt="" class="avatar-img" />
								{:else}
									{rosterLetter(replyBot?.name ?? '?')}
								{/if}
							</div>
							<span class="attached-replying-name">{replyBot?.name ?? deletedText}</span>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	{/if}
{/if}
