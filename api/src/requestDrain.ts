/**
 * Tracks HTTP requests currently in flight so a superseded database handle
 * can be closed only once nothing may still be reading through it — never
 * synchronously with the swap that superseded it.
 *
 * The failure mode this exists to prevent is asymmetric, and only one
 * direction is actually dangerous: closing the old handle too SOON can break
 * a request already mid-read; closing it too LATE only leaves one extra
 * read-only sqlite connection open a little longer than strictly necessary.
 * `whenDrained()` is a plain counter that resolves only once every `begin()`
 * has been matched by an `end()` — by construction it can resolve late (if
 * some request's `end()` never fires, e.g. an abruptly destroyed connection
 * whose `onResponse` hook never runs) but it can never resolve early. Only
 * the safe failure direction is reachable.
 */
export interface Drain {
  whenDrained(): Promise<void>;
}

export class RequestDrain implements Drain {
  private inFlight = 0;
  private waiters: (() => void)[] = [];

  begin(): void {
    this.inFlight++;
  }

  end(): void {
    if (this.inFlight > 0) this.inFlight--;
    if (this.inFlight === 0 && this.waiters.length > 0) {
      const pending = this.waiters;
      this.waiters = [];
      for (const resolve of pending) resolve();
    }
  }

  whenDrained(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }
}

/**
 * Used wherever nothing wires up real request tracking — every test that
 * builds an `IndexManager` without a live Fastify server sitting in front of
 * it. There is no in-flight HTTP request to protect, so draining is
 * instantaneous: a superseded bundle is closed the moment it is superseded.
 */
export const instantDrain: Drain = { whenDrained: () => Promise.resolve() };
