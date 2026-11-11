// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 3d476d90e8a57649
import { state } from "../../lib/reactive";
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
	#rungs$s = state<ModelLadderRung[]>([]);
	get rungs(): ModelLadderRung[] { return this.#rungs$s.get(); }
	set rungs(value: ModelLadderRung[]) { this.#rungs$s.set(value); }
	#available$s = state(false);
	get available() { return this.#available$s.get(); }
	set available(value) { this.#available$s.set(value); }
	#busy$s = state(false);
	get busy() { return this.#busy$s.get(); }
	set busy(value) { this.#busy$s.set(value); }
	#failed$s = state(false);
	get failed() { return this.#failed$s.get(); }
	set failed(value) { this.#failed$s.set(value); }
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
