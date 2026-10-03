import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileSync, statSync, homedir } = vi.hoisted(() => ({ readFileSync: vi.fn(), statSync: vi.fn(), homedir: vi.fn(() => '/synthetic-home') }));
vi.mock('node:fs', () => ({ readFileSync, statSync }));
vi.mock('node:os', () => ({ homedir }));
import { extractPngFromIcns, readInstalledAppIcon, readInstalledWorkBuddyIcon } from '../src/ui/local-app-icons.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const chunk = (type: string, body: Buffer): Buffer => { const h = Buffer.alloc(8); h.write(type, 0, 4, 'ascii'); h.writeUInt32BE(body.length + 8, 4); return Buffer.concat([h, body]); };
const icns = (...chunks: Buffer[]): Buffer => { const body = Buffer.concat(chunks); const h = Buffer.alloc(8); h.write('icns', 0, 4, 'ascii'); h.writeUInt32BE(body.length + 8, 4); return Buffer.concat([h, body]); };
beforeEach(() => { readFileSync.mockReset(); statSync.mockReset(); homedir.mockReset().mockReturnValue('/synthetic-home'); });
afterEach(() => vi.unstubAllGlobals());

describe('extractPngFromIcns', () => {
  it('首选 ic12 并按 ic07、ic11 顺序回退', () => {
    expect(extractPngFromIcns(icns(chunk('ic07', png), chunk('ic12', Buffer.concat([png, Buffer.from([9])]))))).toEqual(Buffer.concat([png, Buffer.from([9])]));
    expect(extractPngFromIcns(icns(chunk('ic11', png)))).toEqual(png);
  });
  it.each([
    ['短头', Buffer.from('icns')], ['错误 magic', icns(chunk('ic12', png)).fill(0, 0, 4)],
    ['容器长度错误', Buffer.concat([icns(chunk('ic12', png)), Buffer.from([0])])],
    ['截断 chunk header', Buffer.concat([icns(), Buffer.from('ic12')])],
    ['短 chunk', (() => { const b = icns(chunk('ic12', png)); b.writeUInt32BE(7, 12); return b; })()],
    ['越界 chunk', (() => { const b = icns(chunk('ic12', png)); b.writeUInt32BE(999, 12); return b; })()],
    ['伪 PNG', icns(chunk('ic12', Buffer.from('notpng!')))],
  ])('拒绝%s', (_label, data) => expect(extractPngFromIcns(data)).toBeUndefined());
  it('拒绝超过 2 MiB 的数据', () => expect(extractPngFromIcns(Buffer.alloc(2 * 1024 * 1024 + 1))).toBeUndefined());
});

describe('固定 App 图标读取', () => {
  const stubDarwin = () => vi.stubGlobal('process', { ...process, platform: 'darwin' });
  const stat = (size: number) => ({ size }) as ReturnType<typeof statSync>;
  it.each(['workbuddy', 'dsh', 'hermes', 'minimax-code', 'trae', 'qoder'])('只从 %s family 固定候选读取', (family) => {
    stubDarwin(); statSync.mockReturnValue(stat(png.length)); readFileSync.mockReturnValue(icns(chunk('ic12', png)));
    expect(readInstalledAppIcon(family)).toEqual(png);
    expect(statSync.mock.calls[0]?.[0]).toContain('/Applications/');
    expect(String(statSync.mock.calls[0]?.[0])).toContain('.app/Contents/Resources/');
  });
  it('Trae 与 Qoder 在 family 内共享固定候选而不接受版本路径', () => {
    stubDarwin(); statSync.mockReturnValue(stat(png.length)); readFileSync.mockReturnValue(icns(chunk('ic12', png)));
    readInstalledAppIcon('trae');
    expect(statSync.mock.calls.map(([path]) => path)).toContain('/Applications/TRAE SOLO CN.app/Contents/Resources/TRAE SOLO CN.icns');
    readFileSync.mockReset(); statSync.mockReset(); statSync.mockReturnValue(stat(png.length)); readFileSync.mockReturnValue(icns(chunk('ic12', png)));
    readInstalledAppIcon('qoder');
    expect(statSync.mock.calls[0]?.[0]).toBe('/Applications/Qoder CN.app/Contents/Resources/icon.icns');
  });
  it('拒绝未知 family、路径穿越、非 macOS，且保留 WorkBuddy 兼容入口', () => {
    stubDarwin();
    expect(readInstalledAppIcon('../etc/passwd')).toBeUndefined(); expect(statSync).not.toHaveBeenCalled();
    expect(readInstalledAppIcon('unknown')).toBeUndefined(); expect(statSync).not.toHaveBeenCalled();
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(readInstalledAppIcon('dsh')).toBeUndefined(); expect(readInstalledWorkBuddyIcon()).toBeUndefined();
    expect(statSync).not.toHaveBeenCalled();
  });
  it('缺文件、超限文件、损坏 ICNS 都安全返回 undefined', () => {
    stubDarwin(); statSync.mockReturnValueOnce(stat(10)).mockReturnValueOnce(stat(2 * 1024 * 1024 + 1));
    readFileSync.mockReturnValue(icns(chunk('ic12', Buffer.from('bad png'))));
    expect(readInstalledAppIcon('dsh')).toBeUndefined();
  });
});
