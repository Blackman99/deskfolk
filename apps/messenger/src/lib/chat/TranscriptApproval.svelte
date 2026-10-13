<script lang="ts">
	/** A request waiting on your approval in the transcript, with the key it may need and its buttons. */
	import PromptEditCard from './PromptEditCard.svelte';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import {
		alwaysAllowFolder,
		approvalForMessage,
		approvalNeedsSecret,
		approvalSecretRequired,
		canAlwaysAllow,
		isPromptEdit,
		isHttpMcpApproval
	} from './approval-card.ts';
	import type { TranscriptGroup } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { TranscriptStage } from './transcript-stage.ts';

	type Props = {
		group: TranscriptGroup;
		t: Copy;
		runtime: MessengerRuntime;
		stage: TranscriptStage;
	};

	let { group, t, runtime, stage }: Props = $props();

	const singleMsg = $derived(group.items[0]);

	async function resolveApprovalCard(card: {
		id: string;
		kind_key: string | null;
		target: string | null;
		requires_api_key: boolean;
	}, action: 'allow_once' | 'deny' | 'always_allow'): Promise<void> {
		const key = stage.approvalKeys[card.id] ?? '';
		if (action === 'allow_once' && approvalSecretRequired(card) && key.trim().length === 0) {
			stage.approvalKeyErrors = { ...stage.approvalKeyErrors, [card.id]: true };
			return;
		}
		const error = await runtime.resolveApproval(card.id, action, key, stage.selected?.id);
		if (error && error.status === 422 && approvalNeedsSecret(card)) {
			stage.approvalKeyErrors = { ...stage.approvalKeyErrors, [card.id]: true };
			return;
		}
		if (!error) {
			const nextKeys = { ...stage.approvalKeys };
			delete nextKeys[card.id];
			stage.approvalKeys = nextKeys;
			const nextErrors = { ...stage.approvalKeyErrors };
			delete nextErrors[card.id];
			stage.approvalKeyErrors = nextErrors;
		}
	}

	function approvalStatusCopy(status: 'allowed_once' | 'denied' | 'voided' | 'pending'): string {
		if (status === 'allowed_once') return t.stream.allowed;
		if (status === 'denied') return t.stream.denied;
		if (status === 'voided') return t.stream.voided;
		return t.stream.approval;
	}
</script>

{#if singleMsg.type === 'message'}
	{@const card = approvalForMessage(stage.snapshot.approvals, singleMsg.message)}
	{@const pending = card?.status === 'pending'}
	<div
		class="msg-wrap is-card-wrap"
		data-message-id={singleMsg.message.id}
		class:is-search-hit={stage.highlightedId === singleMsg.message.id}
		class:is-arriving={stage.arriving.has(singleMsg.message.id)}
	>
		<article class="msg is-approval" class:is-pending={pending}>
			<!-- The head says whose request it is, and while it waits, that it waits on you. -->
			<div class="who approval-head">
				{#if pending}<Icon name="shield-check" size={14} />{/if}
				<span class="approval-label">{pending ? t.stream.waitingApproval : t.stream.approval}</span>
				<span class="approval-who">{stage.who(singleMsg.message)}</span>
			</div>
			<div class="approval-main">
			{#if isPromptEdit(card?.kind_key)}
				<!-- A Bot's change to a built-in prompt (ADR 0064): the change itself, and once allowed, its Undo. -->
				<PromptEditCard body={singleMsg.message.body} {t} approval={card ?? null} api={runtime.client} onOpenSettings={(target) => runtime.openPromptSettings(target)} />
			{:else}
				<div class="body">{singleMsg.message.body}</div>
			{/if}
			{#if card?.status === 'pending'}
				{#if approvalNeedsSecret(card)}
					{@const mcpAuth = isHttpMcpApproval(card.kind_key, card.target) || card.kind_key === 'mcp-add' || card.kind_key === 'mcp-edit'}
					<label class="approval-key" for={`approval-key-${card.id}`}>
						<span>{mcpAuth ? t.stream.mcpAuth : t.stream.endpointKey}</span>
						<input
							id={`approval-key-${card.id}`}
							type="password"
							autocomplete="off"
							value={stage.approvalKeys[card.id] ?? ''}
							oninput={(e) => {
								stage.approvalKeys = {
									...stage.approvalKeys,
									[card.id]: e.currentTarget.value
								};
								if (stage.approvalKeyErrors[card.id]) {
									stage.approvalKeyErrors = { ...stage.approvalKeyErrors, [card.id]: false };
								}
							}}
						/>
						{#if stage.approvalKeyErrors[card.id]}
							<p class="field-error">{mcpAuth ? t.stream.mcpAuthEmpty : t.stream.endpointKeyEmpty}</p>
						{:else}
							<p class="hint">
								{mcpAuth
									? card.kind_key === 'mcp-add'
										? t.stream.mcpAuthHintAdd
										: t.stream.mcpAuthHintEdit
									: card.kind_key === 'endpoint-add'
										? t.stream.endpointKeyHintAdd
										: t.stream.endpointKeyHintEdit}
							</p>
						{/if}
					</label>
				{/if}
				<div class="approval-acts flex gap-4 mt-7 flex-wrap">
					<Button variant="primary" icon="check" onclick={() => void resolveApprovalCard(card, 'allow_once')}
						>{t.stream.allowOnce}</Button
					>
					{#if canAlwaysAllow(card.kind_key)}
						<Button variant="secondary" onclick={() => void resolveApprovalCard(card, 'always_allow')}
							>{t.stream.alwaysAllow}</Button
						>
					{/if}
					<Button variant="ghost" class="deny" onclick={() => void resolveApprovalCard(card, 'deny')}
						>{t.stream.deny}</Button
					>
				</div>
				{@const folder = alwaysAllowFolder(card)}
				{#if folder}
					<p class="always-allow-scope">{t.stream.alwaysAllowCovers(folder, card.kind_key === 'outside-write')}</p>
				{/if}
			{:else if card}
				<p class="muted approval-status">
					{#if card.status === 'allowed_once'}<Icon name="check" size={14} />{:else if card.status === 'denied'}<Icon name="x" size={14} />{/if}
					{approvalStatusCopy(card.status)}
				</p>
			{/if}
			</div>
		</article>
	</div>
{/if}

<style>
	/* Message Wrappers */
	.msg-wrap {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		position: relative;
	}

	.msg-wrap.is-card-wrap {
		max-width: 100%;
		align-self: stretch;
	}

	/* Message Cards */
	.msg {
		position: relative;
		width: fit-content;
		max-width: 100%;
		padding: 10px 14px;
		border-radius: var(--radius-xs) 16px 16px 16px;
		background: var(--bot);
		border: 1px solid var(--bot-border);
		color: var(--bot-text);
		box-shadow: 0 1px 3px rgba(18, 28, 32, 0.03);
		transition: box-shadow 0.15s ease;
		word-break: break-word;
	}

	/* Hide duplicate .who when .msg-header is available */
	.msg-wrap .msg .who {
		display: none;
	}

	/*
	 * Kept visible on the cards that need a speaker line. `.stream-inner > .msg .who` was here
	 * too and never matched — messages sit inside a group wrapper, never directly under
	 * `.stream-inner`. Scoping the sheet is what finally said so.
	 */
	.msg.is-approval .who {
		display: block;
	}

	.msg .who {
		font-size: 11px;
		font-weight: 700;
		margin-bottom: 4px;
		letter-spacing: 0.03em;
		color: var(--muted);
	}

	.msg :global(.body) {
		white-space: pre-wrap;
		line-height: 1.55;
		font-size: 14px;
	}

	/*
	 * Approval Card. Waiting on you, it says so twice over: a warn-tinted head with the shield, and a
	 * soft warn ring round the card. Once answered it settles into a plain card with its outcome.
	 */
	.msg.is-approval {
		align-self: stretch;
		max-width: none;
		padding: 0;
		overflow: hidden;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-xs);
		transition-duration: var(--dur-slow);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.msg.is-approval.is-pending {
		border-color: var(--warn-line);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--warn) 10%, transparent),
			var(--shadow-sm);
	}

	.msg.is-approval .approval-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 9px 16px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: var(--text-caption);
		font-weight: 650;
		letter-spacing: 0;
	}

	.msg.is-approval.is-pending .approval-head {
		background: var(--warn-bg);
		border-bottom-color: var(--warn-line);
		color: var(--warn-text);
	}

	.approval-who {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.approval-who::before {
		content: '·';
		margin-right: 6px;
		color: var(--muted-light);
	}

	.approval-main {
		padding: 12px 16px 14px;
	}

	.approval-status {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 10px 0 0;
		font-size: var(--text-small);
	}

	.always-allow-scope {
		margin: 8px 0 0;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.approval-key {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 12px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.approval-key :global(input[type="password"]) {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 11px;
		background: var(--input-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 400;
		box-shadow: var(--shadow-xs);
	}

	.approval-key :global(input[type="password"]:focus) {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
		outline: none;
	}

	.approval-key :global(.hint) {
		margin: 0;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted);
	}

	.approval-key :global(.field-error) {
		margin: 0;
		font-size: 12px;
		font-weight: 400;
		color: var(--danger);
	}

	.msg-wrap.is-search-hit {
		scroll-margin-top: 28px;
		scroll-margin-bottom: 28px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		animation: search-hit-pulse 1.1s ease-out;
	}

	@keyframes search-hit-pulse {
		0% {
		box-shadow: 0 0 0 0 var(--accent-glow);
		}
		45% {
		box-shadow: 0 0 0 6px var(--accent-glow);
		}
		100% {
		box-shadow: 0 0 0 2px var(--accent-border);
		}
	}

	@media (max-width: 680px), (pointer: coarse) {
		.msg-wrap,
		.msg,
		.msg :global(*) {
			-webkit-touch-callout: none;
			-webkit-user-select: none;
			user-select: none;
		}
	}
	@container conversation (max-width: 680px) {
		.msg {
			padding: 9px 12px;
		}
	}

	/* A row that has just arrived rises into place; history and a reply replacing its working bubble do not. */
	.is-arriving {
		animation: msg-arrive var(--dur-slow) var(--ease-out) both;
	}

	@keyframes msg-arrive {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
