// T019 enc:v1 AES-256-GCM 解密（credential-cipher.ts 移植的正确性）。

import { describe, expect, it } from 'vitest';
import {
  createZcodeCredentialCipher,
  isEncryptedZcodeCredentialValue,
  zcodeCredentialFallbackSecret,
} from '../../../src/adapters/zcode/decrypt.js';

describe('ZCode 凭据解密', () => {
  it('enc:v1 往返：同 cipher 加密后可解回原文', () => {
    const cipher = createZcodeCredentialCipher({ env: {}, home: '/Users/t', username: 't' });
    const token = 'a'.repeat(204);
    const encrypted = cipher.encrypt(token);
    expect(isEncryptedZcodeCredentialValue(encrypted)).toBe(true);
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe(token);
  });

  it('fallback secret 公式与官方一致（zcode-credential-fallback:platform:home:user）', () => {
    expect(zcodeCredentialFallbackSecret({ home: '/Users/alice', username: 'alice' })).toBe(
      `zcode-credential-fallback:darwin:/Users/alice:alice`,
    );
  });

  it('ZCODE_CREDENTIAL_SECRET env 优先于 fallback 公式', () => {
    const a = createZcodeCredentialCipher({ env: { ZCODE_CREDENTIAL_SECRET: 'k1' }, home: '/h', username: 'u' });
    const b = createZcodeCredentialCipher({ env: { ZCODE_CREDENTIAL_SECRET: 'k2' }, home: '/h', username: 'u' });
    const encrypted = a.encrypt('secret-value');
    // 密钥不同 → GCM auth 失败抛错（互解不通）
    expect(() => b.decrypt(encrypted)).toThrow(/解密失败/);
    expect(a.decrypt(encrypted)).toBe('secret-value');
  });

  it('非 enc:v1 值原样直通（官方同语义）', () => {
    const cipher = createZcodeCredentialCipher({ env: {} });
    expect(cipher.decrypt('plain-jwt-value')).toBe('plain-jwt-value');
  });

  it('损坏密文/坏格式报可读错误', () => {
    const cipher = createZcodeCredentialCipher({ env: {} });
    expect(() => cipher.decrypt('enc:v1:only-one-part')).toThrow(/格式不合法/);
    expect(() => cipher.decrypt('enc:v1:////')).toThrow(); // base64url 解出空段 → 格式/长度错误
  });
});
