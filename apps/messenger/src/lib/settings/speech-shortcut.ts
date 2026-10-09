import { connectorFor, speechPreset, type PatchSpeechRequest, type Provider, type SpeechSettings } from '@real-bot/protocol';

/**
 * A Bailian endpoint already set up (the built-in Qwen connector, ADR 0072) can lend its key to
 * speech recognition (ADR 0073): one press points speech at the plan's own speech model, the key
 * read from that endpoint at each call. Token Plan takes speech only through DashScope's own API at
 * its host; pay-as-you-go keys take Qwen ASR at the compatible-mode address they were added with.
 */
export type SpeechShortcut = {
	provider: Provider;
	/** The connector plan, e.g. `qwen:token-plan`, for its label. */
	planKey: string;
	patch: PatchSpeechRequest;
};

function origin(url: string): string {
	const match = /^(https?:\/\/[^/?#]+)/i.exec(url.trim());
	return match ? match[1]! : url.trim();
}

export function speechShortcuts(providers: readonly Provider[]): SpeechShortcut[] {
	const out: SpeechShortcut[] = [];
	for (const provider of providers) {
		if (!provider.key_set || !provider.base_url) continue;
		const found = connectorFor(provider.base_url, provider.api_format);
		if (found?.connector.id !== 'qwen') continue;
		const preset = speechPreset(found.plan.id === 'token-plan' ? 'bailian_token_plan' : 'bailian');
		out.push({
			provider,
			planKey: `qwen:${found.plan.id}`,
			patch: {
				enabled: true,
				preset: preset.id,
				format: preset.format,
				base_url: preset.format === 'dashscope' ? origin(provider.base_url) : provider.base_url,
				model: preset.model,
				key_provider_id: provider.id,
			},
		});
	}
	return out;
}

/** Shortcuts not already in use: speech taking that endpoint's key at that plan's address. */
export function offeredShortcuts(providers: readonly Provider[], speech: SpeechSettings | null): SpeechShortcut[] {
	return speechShortcuts(providers).filter(
		(shortcut) =>
			!(speech?.enabled && speech.key_provider_id === shortcut.provider.id && speech.preset === shortcut.patch.preset)
	);
}
