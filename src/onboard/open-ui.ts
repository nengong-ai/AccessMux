import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Agent 有内置浏览器时用 --no-open-ui，再自行打开打印的 URL。 */
export async function openUi(
  url: string,
  deps: { platform?: string; env?: NodeJS.ProcessEnv; run?: (file: string, args: string[]) => Promise<unknown> } = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('仅允许打开本地 UI');
  const run = deps.run ?? ((file, args) => promisify(execFile)(file, args, { timeout: 5_000 }));
  try {
    if (platform === 'darwin') await run('open', [url]);
    else if (platform === 'win32') await run('rundll32', ['url.dll,FileProtocolHandler', url]);
    else await run('xdg-open', [url]);
    return true;
  } catch { return false; }
}
