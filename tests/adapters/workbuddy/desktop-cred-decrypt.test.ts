// WorkBuddy AES-256-GCM 端到端解密测试（端口 spec §7.1）。
//
// 测试用合成 atRest key + 真实 AES-256-GCM 加密造一段 envelope，验证
// decryptWorkBuddyField 真的能解出原文。覆盖：
// - 正常 round-trip
// - keyId 不匹配抛错
// - AAD 改变后 authTag 校验失败
// - corrupted ciphertext 抛错

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeMatchesKey,
  decryptWorkBuddyField,
  deriveProtectorKey,
} from '../../../src/adapters/workbuddy/desktop-cred-decrypt.js';
import { buildAuthenticatedContextAad } from '../../../src/adapters/workbuddy/desktop-cred-aad.js';
import type { WorkBuddyEncryptedField } from '../../../src/adapters/workbuddy/desktop-cred-envelope.js';

function makeField(atRestKey: string, plaintext: string): WorkBuddyEncryptedField {
  const key = deriveProtectorKey(atRestKey);
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const nonce = randomBytes(12);
  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  const aad = (() => {
    return buildAuthenticatedContextAad({
      suite: 1,
      keyId,
      nonce,
      authTag: Buffer.alloc(16),
      ciphertext: plaintextBuf,
    });
  })();
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { suite: 1, keyId, nonce, authTag, ciphertext };
}

describe('deriveProtectorKey', () => {
  it('输出 32 字节（SHA-256）', () => {
    expect(deriveProtectorKey('any-key').length).toBe(32);
  });

  it('相同 atRest key → 相同派生 key', () => {
    expect(deriveProtectorKey('k').equals(deriveProtectorKey('k'))).toBe(true);
  });

  it('不同 atRest key → 不同派生 key', () => {
    expect(deriveProtectorKey('k1').equals(deriveProtectorKey('k2'))).toBe(false);
  });
});

describe('assertEnvelopeMatchesKey', () => {
  it('匹配时通过', () => {
    const key = deriveProtectorKey('k');
    const field = makeField('k', 'x');
    expect(() => assertEnvelopeMatchesKey(field, key)).not.toThrow();
  });

  it('不匹配抛错', () => {
    const wrongKey = deriveProtectorKey('wrong');
    const field = makeField('right', 'x');
    expect(() => assertEnvelopeMatchesKey(field, wrongKey)).toThrow(/keyId does not match/);
  });

  it('key 长度不对抛错', () => {
    const field = makeField('k', 'x');
    expect(() => assertEnvelopeMatchesKey(field, Buffer.alloc(16))).toThrow(/protector key must be/);
  });
});

describe('decryptWorkBuddyField', () => {
  it('round-trip 解出原文', () => {
    const atRest = 'super-secret';
    const plaintext = '{"accessToken":"jwt.here.here","refreshToken":"jwt.refresh"}';
    const field = makeField(atRest, plaintext);
    expect(decryptWorkBuddyField(field, atRest)).toBe(plaintext);
  });

  it('AAD 改变（keyId 改）解不出', () => {
    const atRest = 'k';
    const field = makeField(atRest, 'x');
    const tampered = { ...field, keyId: '0000000000000000' };
    expect(() => decryptWorkBuddyField(tampered, atRest)).toThrow();
  });

  it('ciphertext 损坏解不出', () => {
    const atRest = 'k';
    const field = makeField(atRest, 'x');
    const tampered = { ...field, ciphertext: Buffer.concat([field.ciphertext, Buffer.from([0xff])]) };
    expect(() => decryptWorkBuddyField(tampered, atRest)).toThrow(/AES-GCM auth failed/);
  });

  it('authTag 错解不出', () => {
    const atRest = 'k';
    const field = makeField(atRest, 'x');
    const tampered = { ...field, authTag: Buffer.alloc(16, 0) };
    expect(() => decryptWorkBuddyField(tampered, atRest)).toThrow(/AES-GCM auth failed/);
  });

  it('nonce 错解不出', () => {
    const atRest = 'k';
    const field = makeField(atRest, 'x');
    const tampered = { ...field, nonce: Buffer.alloc(12, 0) };
    expect(() => decryptWorkBuddyField(tampered, atRest)).toThrow();
  });

  it('派生 key 错（keyId mismatch）抛错', () => {
    const field = makeField('right', 'x');
    expect(() => decryptWorkBuddyField(field, 'wrong')).toThrow(/keyId does not match/);
  });
});