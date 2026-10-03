// Qoder PAT 本机存放（T027）。
//
// 存放位置：`~/.accessmux/qoder.pat`（环境变量 ACCESSMUX_QODER_PAT_FILE 可覆盖），
// 权限 0600。不放主配置 config.yaml 的原因（两个都会咬人，且都在其它模块里）：
// 1. Web UI 保存配置时重建文档，未知顶层键会被丢掉——PAT 会静默消失；
// 2. /api/state 会把整个 config 回给浏览器——PAT 不该出现在任何 HTTP 响应里。
// 因此 `accessmux checkin --set-pat` 只写这个专用文件；config.yaml 的
// `qoder.pat` 仍被读取（兼容手写配置），文档推荐用 --set-pat。
//
// 原值约束：只读写文件，任何日志/错误消息不回显 PAT 内容。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileSync } from '../util/private-file.js';
import { accessmuxConfigHome } from '../config/paths.js';

export const QODER_PAT_FILE_ENV = 'ACCESSMUX_QODER_PAT_FILE';
export const QODER_PAT_FILENAME = 'qoder.pat';

export function qoderPatPath(env: Record<string, string | undefined> = process.env): string {
  const override = env[QODER_PAT_FILE_ENV]?.trim();
  if (override !== undefined && override !== '') return override;
  return join(accessmuxConfigHome(), QODER_PAT_FILENAME);
}

/** 读 PAT；文件不存在/为空 → undefined（调用方按"未配置"处理）。 */
export function readQoderPat(path?: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path ?? qoderPatPath(), 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 写 PAT：0700 父目录、0600 同目录临时文件后原子替换。
 * 拒绝不可信链接；返回路径，不回显内容。
 */
export function writeQoderPat(pat: string, path?: string): { path: string } {
  const target = path ?? qoderPatPath();
  const value = pat.trim();
  if (value === '') throw new Error('PAT 为空，未写入');
  writePrivateFileSync(target, `${value}\n`);
  return { path: target };
}
