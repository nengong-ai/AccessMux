// WorkBuddy AES-256-GCM 凭据解密（端口 spec §7.1 + dsh-workbuddy-connect/
// desktop-credential-protection.ts:249-258 / 286-313）。
//
// 解密管线：
//   key = sha256(atRestSecretKey, utf8).digest()
//   keyId = sha256(key).hex().slice(0, 16)
//   AAD  = buildAuthenticatedContextAad(field)        (46 字节)
//   AES-256-GCM(key, nonce, AAD, ciphertext, authTag)
// 输出 UTF-8 字符串（通常是 JSON 子结构）。

import { createDecipheriv, createHash } from 'node:crypto';
import { buildAuthenticatedContextAad } from './desktop-cred-aad.js';
import type { WorkBuddyEncryptedField } from './desktop-cred-envelope.js';

const EXPECTED_KEY_LENGTH = 32;

/**
 * 从 `electron_browser_workbuddy_storage.loggerGet()` 返回的 atRestSecretKey
 * 派生 32 字节 AES-256 key：sha256(atRestSecretKey, utf8).digest()。
 */
export function deriveProtectorKey(atRestSecretKey: string): Buffer {
  const utf8 = Buffer.from(atRestSecretKey, 'utf8');
  return createHash('sha256').update(utf8).digest();
}

/**
 * 验证 envelope.keyId 与派生 key 的 sha256[0..16] 一致；不一致说明 atRest
 * key 错了（key 与 envelope 不匹配）。先验证再解密，省一次失败的 GCM 调用。
 */
export function assertEnvelopeMatchesKey(field: WorkBuddyEncryptedField, key: Buffer): void {
  if (key.length !== EXPECTED_KEY_LENGTH) {
    throw new Error(`WorkBuddy protector key must be ${EXPECTED_KEY_LENGTH} bytes, got ${key.length}`);
  }
  const expected = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (expected.toLowerCase() !== field.keyId) {
    throw new Error(
      `WorkBuddy envelope.keyId does not match the derived key (expected ${expected}, got ${field.keyId})`,
    );
  }
}

/**
 * 解一段加密字段 → UTF-8 字符串。atRestSecretKey 是 spawn helper 拿到的 32 字节
 * 原始 key，accessmux 不落盘。
 *
 * 错误形态：
 *   - 'Envelope mismatch': key 与 envelope 不匹配（spawn helper 过期？）
 *   - 'AES-GCM auth failed': AAD 拼错 / data 损坏 / wrong key
 */
export function decryptWorkBuddyField(
  field: WorkBuddyEncryptedField,
  atRestSecretKey: string,
): string {
  const key = deriveProtectorKey(atRestSecretKey);
  assertEnvelopeMatchesKey(field, key);
  const aad = buildAuthenticatedContextAad(field);
  const decipher = createDecipheriv('aes-256-gcm', key, field.nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(field.authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(field.ciphertext), decipher.final()]);
  } catch (error: unknown) {
    throw new Error(`WorkBuddy AES-GCM auth failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return plaintext.toString('utf8');
}