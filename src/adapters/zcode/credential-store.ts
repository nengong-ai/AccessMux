// ZCode 凭据读取（T019，R014 合同）。
// 只读 `~/.zcode/v2/credentials.json`（解密 zcodejwttoken）与
// `~/.zcode/v2/telemetry-state.json`（deviceMid，balance 头用；缺失时自生成
// UUID——服务端只校验存在性，R014 §1.3.1 结论 2）。
// 生命周期结论（R014 §1.3.1 结论 1）：JWT 无 exp、无 refresh 流程；失效只能
// 用户重新登录 ZCode。adapter 不做刷新，401 即降级"需重新登录"。
// 解密在 Node 进程内存中进行，token 不落盘、不入日志（回执只给指纹）。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createZcodeCredentialCipher, isEncryptedZcodeCredentialValue } from './decrypt.js';

export const ZCODE_JWT_KEY = 'zcodejwttoken';

export class ZcodeCredentialError extends Error {
  constructor(message: string, readonly reason: 'missing' | 'unreadable' = 'unreadable') {
    super(message);
    this.name = 'ZcodeCredentialError';
  }
}

export interface ZcodeCredentialDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  username?: string;
}

export interface ZcodeCredential {
  /** zcodejwttoken 明文（仅进程内使用；严禁落日志/回执） */
  jwt: string;
  /** balance 请求的 X-Device-Mid 值 */
  deviceMid: string;
  /** deviceMid 来源：真实 telemetry 文件 or 本地生成 */
  deviceMidSource: 'telemetry-state' | 'generated';
}

function readJsonFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new ZcodeCredentialError(`读不到 ${path}：${(error as Error).message}`, (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层不是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ZcodeCredentialError(`${path} 不是合法 JSON：${(error as Error).message}`);
  }
}

/** JWT 形状自检：3 段点分（算法/载荷/签名）。不解析 claims、不判过期（无 exp，R014）。 */
export function assertJwtShape(jwt: string): void {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new ZcodeCredentialError(
      `zcodejwttoken 形状不合法（期望 3 段 JWT，实际 ${parts.length} 段）`,
    );
  }
}

export function loadZcodeCredential(deps: ZcodeCredentialDeps = {}): ZcodeCredential {
  const home = deps.home ?? homedir();
  const credentials = readJsonFile(join(home, '.zcode', 'v2', 'credentials.json'));
  const raw = credentials[ZCODE_JWT_KEY];
  if (typeof raw !== 'string' || raw === '') {
    throw new ZcodeCredentialError(
      'credentials.json 里没有 zcodejwttoken（ZCode 未登录或登录态不完整）',
    );
  }
  let jwt: string;
  if (isEncryptedZcodeCredentialValue(raw)) {
    jwt = createZcodeCredentialCipher(deps).decrypt(raw);
  } else {
    // 官方实现允许明文值直通（decrypt 对非 enc:v1 原样返回）；保持同语义
    jwt = raw;
  }
  assertJwtShape(jwt);

  let deviceMid = '';
  let deviceMidSource: ZcodeCredential['deviceMidSource'] = 'generated';
  try {
    const telemetry = readJsonFile(join(home, '.zcode', 'v2', 'telemetry-state.json'));
    const mid = telemetry['deviceMid'];
    if (typeof mid === 'string' && mid !== '') {
      deviceMid = mid;
      deviceMidSource = 'telemetry-state';
    }
  } catch {
    // telemetry 文件缺失/不合法 → 自生成（服务端只校验存在性）
  }
  if (deviceMid === '') deviceMid = randomUUID();
  return { jwt, deviceMid, deviceMidSource };
}
