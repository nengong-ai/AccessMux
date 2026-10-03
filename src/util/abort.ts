/** Await one caller's work without retaining its listener after cancellation. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) onAbort();
  });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve();
    };
    const onAbort = () => finish(signal?.reason);
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One owned operation: cancelling a waiter only cancels underlying work when no waiter remains. */
export class SharedWork<T> {
  private current?: { controller: AbortController; work: Promise<T>; waiters: number; settled: boolean };
  run(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let flight = this.current;
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, work: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return start(controller.signal); }), waiters: 0, settled: false };
      this.current = flight;
      const owned = flight;
      void owned.work.then(() => this.finish(owned), () => this.finish(owned));
    }
    flight.waiters++;
    const owned = flight;
    return abortable(owned.work, signal).finally(() => {
      owned.waiters--;
      if (!owned.settled && owned.waiters === 0) owned.controller.abort(new Error('operation has no remaining callers'));
    });
  }
  cancel(reason: Error = new Error('operation disposed')): void { this.current?.controller.abort(reason); }
  private finish(owned: NonNullable<SharedWork<T>['current']>): void {
    owned.settled = true;
    if (this.current === owned) this.current = undefined;
  }
}
