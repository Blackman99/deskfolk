import type { ModelLadderResponse, ModelLadderRung } from '@real-bot/protocol';

/** The slice of the API the model ladder uses (ADR 0054). */
export type ModelLadderApi = {
	modelLadder: () => Promise<ModelLadderResponse>;
	setModelLadder: (items: ModelLadderRung[]) => Promise<ModelLadderResponse>;
};

/**
 * The model ladder as the models settings hold it. It is read before its own page opens: the
 * section list shows it only on an engine level that has one, and says what is on it.
 */
export class ModelLadder {
	rungs = $state<ModelLadderRung[]>([]);
	available = $state(false);
	busy = $state(false);
	failed = $state(false);
	readonly #api: () => ModelLadderApi | null;

	constructor(api: () => ModelLadderApi | null) {
		this.#api = api;
	}

	async load(): Promise<void> {
		const api = this.#api();
		if (!api) return;
		try {
			const page = await api.modelLadder();
			this.rungs = page.items;
			this.available = page.available;
		} catch {
			this.available = false;
		}
	}

	async save(next: ModelLadderRung[]): Promise<void> {
		const api = this.#api();
		if (!api || this.busy) return;
		const before = this.rungs;
		this.rungs = next;
		this.busy = true;
		this.failed = false;
		try {
			this.rungs = (await api.setModelLadder(next)).items;
		} catch {
			this.rungs = before;
			this.failed = true;
		} finally {
			this.busy = false;
		}
	}
}
