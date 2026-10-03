import { abortable } from '../util/abort.js';
// 有界控制面调用；signal 供支持取消的 adapter 使用，旧接口保持兼容。
import type { ProviderAdapter, ProbeResult, ProbeContext } from '../adapters/types.js';
import type { Config } from '../config/schema.js';

export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

export function adapterEnabled(id: string, cfg?: Config, env: Record<string, string | undefined> = process.env): boolean {
  const disabled = (env['ACCESSMUX_DISABLE_ADAPTERS'] ?? '').split(',').map((s) => s.trim());
  return !disabled.includes(id) && cfg?.adapters[id]?.enabled !== false;
}

// 同一挂起源不因浏览器刷新不断新增后台工作。只有旧调用退出才允许再次探测。
const pending = new WeakMap<ProviderAdapter, Promise<ProbeResult>>();
export interface ProbeAttempt {
  status: 'ready' | 'pending' | 'timeout' | 'failed';
  result?: ProbeResult;
  checkedAt: string;
}
export async function probeWithBudgetDetailed(
  adapter: ProviderAdapter,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  options: Pick<ProbeContext, 'forceRefresh' | 'signal'> = {},
): Promise<ProbeAttempt> {
  const checkedAt = new Date().toISOString();
  if (options.signal?.aborted) return { status: 'failed', checkedAt };
  if (pending.has(adapter)) return { status: 'pending', checkedAt };
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONTROL_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return adapter.probe({ signal: controller.signal, forceRefresh: options.forceRefresh });
  });
  pending.set(adapter, work);
  void work.then(() => pending.delete(adapter), () => pending.delete(adapter));
  try {
    const outcome = await Promise.race([
      abortable(work, controller.signal).then((result) => ({ status: 'ready' as const, result })),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error('控制面探测超时'));
          resolve({ status: 'timeout' });
        }, budget);
      }),
    ]);
    return { ...outcome, checkedAt };
  } catch {
    return { status: 'failed', checkedAt };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** 兼容旧调用方；UI 使用详细状态避免把 pending/timeout 当成一次成功刷新。 */
export async function probeWithBudget(
  adapter: ProviderAdapter,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  options: Pick<ProbeContext, 'forceRefresh' | 'signal'> = {},
): Promise<ProbeResult | undefined> {
  return (await probeWithBudgetDetailed(adapter, timeoutMs, options)).result;
}
