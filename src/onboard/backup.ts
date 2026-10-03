// 备份：每次写宿主配置前先落一份带时间戳的原样快照（保内容、保权限、不覆盖旧备份）。

import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { OnboardError } from './errors.js';

export interface BackupDeps {
  /** 注入时钟（测试离线）；默认真实时间 */
  now?: () => Date;
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 备份 absPath → `<absPath>.bak-pre-onboard-<YYYYMMDD-HHMMSS>`。
 * 同名已存在时追加 -2/-3（绝不覆盖任何旧备份）。
 * 返回备份文件绝对路径；原文件不存在返回 null。
 */
export function backupFile(absPath: string, deps: BackupDeps = {}): string | null {
  if (!existsSync(absPath)) return null;
  const mode = statSync(absPath).mode & 0o777;
  const base = `${absPath}.bak-pre-onboard-${stamp(deps.now?.() ?? new Date())}`;
  let target = base;
  for (let i = 2; existsSync(target); i++) {
    target = `${base}-${i}`;
  }
  try {
    copyFileSync(absPath, target);
    chmodSync(target, mode);
  } catch (e) {
    throw new OnboardError(
      `备份失败：${absPath} → ${target}（${String(e)}）。` +
        '备份是写入前的保护步骤，未写入任何修改；请检查磁盘权限后重试。',
    );
  }
  return target;
}
