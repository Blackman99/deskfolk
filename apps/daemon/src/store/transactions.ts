import type { Database } from "bun:sqlite";

export class Transactions {
  private effects: Array<() => void> | null = null;
  private rollbacks: Array<() => void> | null = null;

  constructor(private readonly db: Database, private readonly committed: () => void = () => {}) {}

  run<T>(work: () => T): T {
    if (this.effects) {
      const result = work();
      if (result instanceof Promise) throw new Error("transaction callback must be synchronous");
      return result;
    }
    const effects: Array<() => void> = [];
    this.effects = effects;
    const rollbacks: Array<() => void> = [];
    this.rollbacks = rollbacks;
    let value: T;
    try {
      value = this.db.transaction(() => {
        const result = work();
        if (result instanceof Promise) throw new Error("transaction callback must be synchronous");
        return result;
      })();
    } catch (error) {
      for (const rollback of rollbacks.reverse()) rollback();
      throw error;
    } finally {
      this.effects = null;
      this.rollbacks = null;
    }
    this.committed();
    for (const effect of effects) effect();
    return value;
  }

  afterRollback(effect: () => void): void {
    if (!this.rollbacks) throw new Error("rollback callback needs a transaction");
    this.rollbacks.push(effect);
  }

  afterCommit(effect: () => void): void {
    if (this.effects) this.effects.push(effect);
    else effect();
  }
}
