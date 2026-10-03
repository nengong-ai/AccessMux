import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortable, abortableDelay, SharedWork } from '../../src/util/abort.js';

afterEach(() => vi.useRealTimers());
describe('owned cancellation and shared callers', () => {
  it('hanging work removes its abort listener immediately when caller cancels', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = abortable(new Promise<void>(() => {}), controller.signal);
    const failed = expect(pending).rejects.toThrow('stop');
    controller.abort(new Error('stop')); await failed;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('delay releases both timer and listener on success and abort', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const first = abortableDelay(20, controller.signal); await vi.advanceTimersByTimeAsync(20); await first;
    const next = abortableDelay(100, controller.signal); const failed = expect(next).rejects.toThrow();
    controller.abort(); await failed;
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledTimes(2);
  });
  it('one cancelled caller leaves the other alive; last cancellation stops work and permits retry', async () => {
    const shared = new SharedWork<string>(); const a = new AbortController(); const b = new AbortController();
    let owned!: AbortSignal; let resolve!: (value: string) => void;
    const start = vi.fn((signal: AbortSignal) => { owned = signal; return new Promise<string>(r => { resolve = r; signal.addEventListener('abort', () => r('stopped'), {once:true}); }); });
    const first = shared.run(start, a.signal); const second = shared.run(start, b.signal);
    const failed = expect(first).rejects.toThrow(); await Promise.resolve(); a.abort(); await failed;
    expect(owned.aborted).toBe(false); expect(start).toHaveBeenCalledTimes(1);
    resolve('ok'); expect(await second).toBe('ok');
    const third = shared.run(start, b.signal); const thirdFailed = expect(third).rejects.toThrow();
    await Promise.resolve(); b.abort(); await thirdFailed; expect(owned.aborted).toBe(true);
    await Promise.resolve(); expect(await shared.run(async () => 'next')).toBe('next');
  });
  it('already aborted call never starts shared work', async () => {
    const controller = new AbortController(); controller.abort(); const start = vi.fn();
    expect(() => new SharedWork().run(start, controller.signal)).toThrow(); expect(start).not.toHaveBeenCalled();
  });
});
