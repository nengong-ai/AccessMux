// Trae 自实现 AES-128-CBC 解密（D11 + 端口 spec §7.3）：
// - 算法完全自包含（不依赖 Electron safeStorage / Keychain / DPAPI）
// - 不触发 reverse-skill 授权门（D11-5）
// - SALT_A/B/C/D 常量来自公开仓库交叉验证；README 注明"基于公开抓包 / 协议分析"
//
// 与 dsh-connect-trae/src/decrypt.ts 同步移植；本目录就是 Trae 协议事实的权威来源。

import { createDecipheriv, createHash } from 'node:crypto';

/** storage.json 中存放加密凭据的键名。 */
export const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';

type EncryptionType = 'aes' | 'aes-private';

/**
 * SALT 常量：与 dsh-connect-trae 同源，来自 Wang-JQ77/dsh-trae-api、
 * Sliverkiss/traework2api 等公开仓库交叉验证。AccessMux 硬编码后必须
 * 在 README 注明"基于公开抓包 / 协议分析"。绝不允许下游协作者动态抓取。
 */
const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209]);
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170]);

function xor(a: Uint8Array, b: Uint8Array): Buffer {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}

function encryptionType(header: Buffer): EncryptionType {
  if (header.equals(Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]))) return 'aes';
  if (header.equals(Buffer.from([18, 57, 32, 32, 2, 3]))) return 'aes-private';
  throw new Error('unsupported Trae auth encryption header');
}

/**
 * 解密 storage.json 中的 iCubeAuthInfo://icube.cloudide 字段。
 * 完整管线：6B header → 32B random → ciphertext；SHA512(random) → first；
 * SHA512(first || salt) → derived[0:16] 是 AES key，derived[16:32] 是 IV；
 * 明文前 64B 是 sha512(plaintext) 的摘要（用作校验）。
 */
export function decryptTraeStorageValue(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length <= 102) throw new Error('Trae auth ciphertext is too short');
  const type = encryptionType(buf.subarray(0, 6));
  const random = buf.subarray(6, 38);
  const encrypted = buf.subarray(38);
  const salt = type === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const first = createHash('sha512').update(random).digest();
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest();
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error('Trae auth plaintext is too short');
  const expected = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actual = createHash('sha512').update(plaintext).digest();
  if (!expected.equals(actual)) throw new Error('Trae auth integrity check failed');
  return plaintext.toString('utf8');
}

/**
 * 解析 storage.json 中的 auth 字段：可能是明文 JSON，也可能是 base64 加密值。
 * 抛出说明加密头 / 完整性校验失败。
 */
export function parseTraeAuthValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error('Trae auth value is empty');
  const plaintext = trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed);
  try { return JSON.parse(plaintext) as unknown; } catch { throw new Error('Trae auth plaintext is not valid JSON'); }
}

/** 解析整份 storage.json，从 `iCubeAuthInfo://icube.cloudide` 键拿到明文。 */
export function parseTraeStorageDocument(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Trae storage document is not valid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Trae storage document must be an object');
  }
  const value = (parsed as Record<string, unknown>)[TRAE_AUTH_STORAGE_KEY];
  if (typeof value !== 'string') {
    throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
  }
  return parseTraeAuthValue(value);
}

export interface TraeCliTokenClaims {
  /** JWT 原值，作为 `Cloud-IDE-JWT` bearer。 */
  accessToken: string;
  /** `data.user_id`；与 desktop 同账号时一致。 */
  userId: string;
  /** `exp` 转换后的 epoch ms；缺失或无法解析时为 undefined。 */
  expiresAtMs?: number;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 解析 CLI 写的 trae-jwt-token：裸 JWT，不走 AES。允许裸 JWT 或 JSON envelope
 * 两种形态（macOS 实测是裸 JWT，但未来 CLI 可能改包）。
 *
 * 不验证签名：上游每次请求都会再验，本地消费不必。
 */
export function parseTraeCliToken(text: string): TraeCliTokenClaims {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('Trae CLI token file is empty');
  let token = trimmed;
  if (trimmed.startsWith('{')) {
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(trimmed) as Record<string, unknown>; } catch { throw new Error('Trae CLI token document is not valid JSON'); }
    const candidate = envelope['token'] ?? envelope['accessToken'] ?? envelope['jwt'];
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error('Trae CLI token document has no token field');
    }
    token = candidate.trim();
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((s) => s === '')) {
    throw new Error('Trae CLI token is not a three-part JWT');
  }
  const payload = decodeBase64UrlJson(segments[1] ?? '');
  if (payload === undefined) throw new Error('Trae CLI token payload is not decodable JSON');
  const data = typeof payload['data'] === 'object' && payload['data'] !== null && !Array.isArray(payload['data'])
    ? payload['data'] as Record<string, unknown>
    : undefined;
  const userId = typeof data?.['user_id'] === 'string' ? data['user_id'] : undefined;
  if (userId === undefined || userId === '') {
    throw new Error('Trae CLI token has no data.user_id claim');
  }
  const exp = payload['exp'];
  const expiresAtMs = typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  return { accessToken: token, userId, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) };
}