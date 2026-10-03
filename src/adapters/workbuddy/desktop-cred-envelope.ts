// WorkBuddy `$wbEncrypted` envelope 解析（WBEV1 / 端口 spec §7.1）。
//
// 文件形态：每个加密字段都是 `{ "$wbEncrypted": 1, envelope: '<base64 of JSON>' }`。
// envelope base64 解码后是 `{ suite, keyId, nonce, authTag, ciphertext }`：
//   - suite: 数字（dsh 看到仅 1，"only suite 1 seen today"）
//   - keyId: 16 hex 字符
//   - nonce: base64, 12 字节
//   - authTag: base64, 16 字节
//   - ciphertext: base64, 任意长度
//
// 实际解密由 desktop-cred-decrypt.ts 负责；本文件只做 envelope 拆解 + 长度校验。

export interface WorkBuddyEncryptedField {
  suite: number;
  keyId: string;
  nonce: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

const NONCE_LENGTH = 12;
const AUTHTAG_LENGTH = 16;
const KEY_ID_LENGTH = 16;
const SUPPORTED_SUITE = 1;

/**
 * 拆一个加密字段。原始值必须是 `{ "$wbEncrypted": 1, envelope: <string> }`
 * 形态；其他视为明文字段返回 undefined，让上层走"未加密路径"。
 */
export function parseWorkBuddyEncryptedField(value: unknown): WorkBuddyEncryptedField | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['$wbEncrypted'] !== 1) return undefined;
  const envelopeRaw = record['envelope'];
  if (typeof envelopeRaw !== 'string' || envelopeRaw.trim() === '') return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(envelopeRaw, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined;
  const envelopeRecord = envelope as Record<string, unknown>;
  const suite = envelopeRecord['suite'];
  const keyId = envelopeRecord['keyId'];
  const nonce = envelopeRecord['nonce'];
  const authTag = envelopeRecord['authTag'];
  const ciphertext = envelopeRecord['ciphertext'];
  if (suite !== SUPPORTED_SUITE) return undefined;
  if (typeof keyId !== 'string' || keyId.length !== KEY_ID_LENGTH || !/^[0-9a-f]+$/i.test(keyId)) return undefined;
  if (typeof nonce !== 'string') return undefined;
  if (typeof authTag !== 'string') return undefined;
  if (typeof ciphertext !== 'string' || ciphertext === '') return undefined;
  let nonceBytes: Buffer;
  let authTagBytes: Buffer;
  let ciphertextBytes: Buffer;
  try {
    nonceBytes = Buffer.from(nonce, 'base64');
    authTagBytes = Buffer.from(authTag, 'base64');
    ciphertextBytes = Buffer.from(ciphertext, 'base64');
  } catch {
    return undefined;
  }
  if (nonceBytes.length !== NONCE_LENGTH) return undefined;
  if (authTagBytes.length !== AUTHTAG_LENGTH) return undefined;
  if (ciphertextBytes.length === 0) return undefined;
  return {
    suite: SUPPORTED_SUITE,
    keyId: keyId.toLowerCase(),
    nonce: nonceBytes,
    authTag: authTagBytes,
    ciphertext: ciphertextBytes,
  };
}

/**
 * 判断一段字符串是否像加密 envelope（不真正解 base64）。
 * 给 parse_workbuddy_credential 这样的"先嗅探再拆"路径用。
 */
export function isEncryptedEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['$wbEncrypted'] === 1 && typeof record['envelope'] === 'string' && record['envelope'].length > 0;
}