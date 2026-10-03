// B09/R03：安全能力不能实证时禁用整个兜底，不保留隐藏启动路径。
import { describe, expect, it, vi } from 'vitest';
import { ZcodeAppServerHost, APP_SERVER_DISABLED_REASON } from '../../../src/adapters/zcode/app-server.js';

async function consume(host: ZcodeAppServerHost): Promise<void> {
  for await (const chunk of host.runTurn({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'synthetic tool request' }] })) {
    if (chunk.done) break; // 生产 done-break 收尾
  }
}
describe('ZcodeAppServerHost fail closed', () => {
  it('启动、回合和直接 RPC 都拒绝；凭据、进程、日志均不触碰', async () => {
    const spawnImpl = vi.fn(), getJwt = vi.fn(() => 'synthetic-jwt'), log = vi.fn();
    const host = new ZcodeAppServerHost({ spawnImpl, getJwt, log, root: '/never-created', env: { ACCESSMUX_ZCODE_FORM: 'app-server' } });
    await expect(host.ensureStarted()).rejects.toThrow(APP_SERVER_DISABLED_REASON);
    await expect(consume(host)).rejects.toThrow(APP_SERVER_DISABLED_REASON);
    await expect(host.request('session/send', {}, 10)).rejects.toThrow(APP_SERVER_DISABLED_REASON);
    expect(spawnImpl).not.toHaveBeenCalled(); expect(getJwt).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    expect(host.alive).toBe(false);
  });
  it('done-break / dispose→start→dispose / 并发取消均无运行代际、waiter 或定时器可泄漏', async () => {
    const spawnImpl = vi.fn(), getJwt = vi.fn();
    const host = new ZcodeAppServerHost({ spawnImpl, getJwt, idleMs: 1, turnTimeoutMs: 100_000 });
    const a = consume(host), b = consume(host);
    host.cancelCurrentTurn();
    await expect(a).rejects.toThrow('禁用'); await expect(b).rejects.toThrow('禁用');
    await host.dispose(); await expect(host.ensureStarted()).rejects.toThrow('禁用'); await host.dispose();
    expect(host.alive).toBe(false); expect(spawnImpl).not.toHaveBeenCalled();
  });
});
