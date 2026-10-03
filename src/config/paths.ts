// 配置 / 凭据副本等本地持久化文件的根目录解析。
//
// 默认：$XDG_CONFIG_HOME/accessmux/，否则 ~/.accessmux/。
// 不抄 dsh 的 `$DSH_HOME`（端口 spec §2.2.5），AccessMux 自有目录命名空间。

import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | undefined;

export function accessmuxConfigHome(): string {
  if (cached !== undefined) return cached;
  const env = process.env['XDG_CONFIG_HOME'];
  const home = (typeof env === 'string' && env.trim() !== '') ? env : homedir();
  cached = join(home, '.accessmux');
  return cached;
}

/** 测试钩子：把 home 重置回 process.env。 */
export function resetAccessmuxConfigHomeCache(): void {
  cached = undefined;
}