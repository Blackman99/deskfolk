<script lang="ts">
	import {
		avatarEditorPrimaryActions,
		avatarSrc,
		fileToAvatarDataUri,
		generateBoringAvatar,
		isCustomAvatar,
		BORING_AVATAR_VARIANTS,
		type AvatarImageError,
		type BoringAvatarVariant,
	} from './avatar.ts';
	import type { Copy } from './copy.ts';

	interface Props {
		name: string;
		avatar: string | null | undefined;
		t: Copy;
		onchange?: () => void;
	}

	let { name, avatar = $bindable(''), t, onchange }: Props = $props();

	let variant = $state<BoringAvatarVariant>('beam');
	let seed = $state(0);
	let uploadError = $state<AvatarImageError | null>(null);
	let uploading = $state(false);
	let fileInput: HTMLInputElement | undefined;
	let customMode = $derived(isCustomAvatar(avatar));

	const variantLabels: Record<BoringAvatarVariant, { zh: string; en: string }> = {
		beam: { zh: '表情', en: 'Beam' },
		marble: { zh: '大理石', en: 'Marble' },
		pixel: { zh: '像素', en: 'Pixel' },
		sunset: { zh: '日落', en: 'Sunset' },
		bauhaus: { zh: '包豪斯', en: 'Bauhaus' },
		ring: { zh: '环形', en: 'Ring' },
	};

	$effect(() => {
		if (!customMode && (!avatar || avatar.trim().length === 0)) {
			const effectiveName = (name || '').trim() || 'bot';
			avatar = generateBoringAvatar({
				name: seed > 0 ? `${effectiveName}_${seed}` : effectiveName,
				variant,
			});
			onchange?.();
		}
	});

	function applyGenerated(nextVariant: BoringAvatarVariant = variant, nextSeed = seed): void {
		uploadError = null;
		const effectiveName = (name || '').trim() || 'bot';
		avatar = generateBoringAvatar({
			name: nextSeed > 0 ? `${effectiveName}_${nextSeed}` : effectiveName,
			variant: nextVariant,
		});
		onchange?.();
	}

	function randomize(): void {
		seed++;
		applyGenerated(variant, seed);
	}

	function pickVariant(v: BoringAvatarVariant): void {
		variant = v;
		applyGenerated(v, seed);
	}

	function openFilePicker(): void {
		if (uploading) return;
		fileInput?.click();
	}

	async function onFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		uploading = true;
		uploadError = null;
		const result = await fileToAvatarDataUri(file);
		uploading = false;
		if (!result.ok) {
			uploadError = result.error;
			return;
		}
		avatar = result.dataUri;
		onchange?.();
	}

	function uploadErrorCopy(error: AvatarImageError): string {
		if (error === 'type') return t.sidebar.botAvatarInvalidType;
		if (error === 'size') return t.sidebar.botAvatarTooLarge;
		return t.sidebar.botAvatarDecodeFailed;
	}

	let currentSrc = $derived(avatarSrc(avatar) || avatarSrc(generateBoringAvatar({ name: (name || '').trim() || 'bot', variant })));
	let primaryActions = $derived(avatarEditorPrimaryActions(customMode ? 'custom' : 'generated'));
</script>

<div class="avatar-editor">
	<input
		bind:this={fileInput}
		type="file"
		class="sr-only"
		accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
		onchange={onFile}
	/>
	<div class="avatar-editor-main">
		{#if customMode}
			<button
				type="button"
				class="avatar-editor-preview is-upload"
				onclick={openFilePicker}
				disabled={uploading}
				aria-label={t.sidebar.botAvatarCustom}
			>
				{#if currentSrc}
					<img src={currentSrc} alt={name || 'Bot avatar'} class="avatar-editor-img" />
				{:else}
					<div class="avatar-editor-fallback">?</div>
				{/if}
			</button>
		{:else}
			<div class="avatar-editor-preview">
				{#if currentSrc}
					<img src={currentSrc} alt={name || 'Bot avatar'} class="avatar-editor-img" />
				{:else}
					<div class="avatar-editor-fallback">?</div>
				{/if}
			</div>
		{/if}
		<div class="avatar-editor-controls">
			<div class="avatar-editor-actions">
				{#each primaryActions as action (action)}
					{#if action === 'randomize'}
						<button type="button" class="btn-avatar-action" onclick={randomize} title={t.sidebar.botAvatarRefresh}>
							<span class="action-icon">🎲</span>
							<span>{t.sidebar.botAvatarRefresh}</span>
						</button>
					{:else if action === 'style'}
						<button type="button" class="btn-avatar-action" onclick={() => applyGenerated()} title={t.sidebar.botAvatarStyle}>
							<span>{t.sidebar.botAvatarStyle}</span>
						</button>
					{:else}
						<button
							type="button"
							class="btn-avatar-action"
							onclick={openFilePicker}
							disabled={uploading}
						>
							{t.sidebar.botAvatarCustom}
						</button>
					{/if}
				{/each}
			</div>
			{#if !customMode}
				<div class="avatar-variants">
					{#each BORING_AVATAR_VARIANTS as v (v)}
						<button
							type="button"
							class="variant-chip"
							class:is-active={variant === v}
							onclick={() => pickVariant(v)}
						>
							{t.common.you === '你' ? variantLabels[v].zh : variantLabels[v].en}
						</button>
					{/each}
				</div>
			{:else}
				<p class="custom-avatar-hint">{t.sidebar.botAvatarCustomHint}</p>
			{/if}
			{#if uploadError}
				<p class="avatar-error">{uploadErrorCopy(uploadError)}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.avatar-editor {
		margin-bottom: 12px;
	}

	.avatar-editor-main {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.avatar-editor-preview {
		width: 56px;
		height: 56px;
		padding: 0;
		border-radius: 50%;
		border: 2px solid var(--line);
		overflow: hidden;
		flex-shrink: 0;
		background: var(--chip, #f1f5f9);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--shadow-xs);
		appearance: none;
	}

	.avatar-editor-preview.is-upload {
		cursor: pointer;
	}

	.avatar-editor-preview.is-upload:hover {
		border-color: var(--accent);
	}

	.avatar-editor-preview:disabled {
		cursor: wait;
	}

	.avatar-editor-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		border-radius: inherit;
		pointer-events: none;
	}

	.avatar-editor-fallback {
		font-weight: 700;
		color: var(--muted);
		font-size: 20px;
	}

	.avatar-editor-controls {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}

	.avatar-editor-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.btn-avatar-action {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 600;
		border-radius: var(--radius-sm, 6px);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg, var(--pane));
		color: var(--ink);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.btn-avatar-action:hover:not(:disabled) {
		background: var(--btn-secondary-hover, var(--line-subtle));
		border-color: var(--line-hover, #cbd5e1);
	}

	.btn-avatar-action:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.action-icon {
		font-size: 13px;
	}

	.avatar-variants {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.variant-chip {
		padding: 2px 7px;
		font-size: 11px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: all 0.12s ease;
	}

	.variant-chip:hover {
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.variant-chip.is-active {
		background: var(--ink);
		color: var(--pane);
		border-color: var(--ink);
		font-weight: 600;
	}

	.custom-avatar-hint {
		margin: 0;
		font-size: 11px;
		color: var(--muted);
	}

	.avatar-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}
</style>
