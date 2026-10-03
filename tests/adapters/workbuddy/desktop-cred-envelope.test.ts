// WorkBuddy $wbEncrypted envelope 解析（端口 spec §7.1）。
//
// envelope 是 base64 编码的 `{ suite, keyId, nonce, authTag, ciphertext }`。
// 本测试用合成数据：故意造合法 envelope + 各种非法形态，验证 parseWorkBuddyEncryptedField 的
// 校验行为。

import { describe, expect, it } from 'vitest';
import { isEncryptedEnvelope, parseWorkBuddyEncryptedField } from '../../../src/adapters/workbuddy/desktop-cred-envelope.js';

function buildValidEnvelope(): { suite: number; keyId: string; nonce: string; authTag: string; ciphertext: string } {
  const keyId = '9127dea1b44020a3'; // 16 hex chars
  const nonce = Buffer.alloc(12, 1).toString('base64');
  const authTag = Buffer.alloc(16, 2).toString('base64');
  const ciphertext = Buffer.from('hello').toString('base64');
  return { suite: 1, keyId, nonce, authTag, ciphertext };
}

function envelopeField(overrides: Record<string, unknown> = {}): unknown {
  const env = { ...buildValidEnvelope(), ...overrides };
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify(env), 'utf8').toString('base64'),
  };
}

describe('isEncryptedEnvelope', () => {
  it('合法形态返回 true', () => {
    expect(isEncryptedEnvelope(envelopeField())).toBe(true);
  });

  it('非对象返回 false', () => {
    expect(isEncryptedEnvelope('plain string')).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope(42)).toBe(false);
  });

  it('缺 $wbEncrypted 字段返回 false', () => {
    expect(isEncryptedEnvelope({ envelope: 'xxx' })).toBe(false);
  });

  it('envelope 不是字符串返回 false', () => {
    expect(isEncryptedEnvelope({ $wbEncrypted: 1, envelope: 42 })).toBe(false);
  });
});

describe('parseWorkBuddyEncryptedField', () => {
  it('合法 envelope 拆出五个字段', () => {
    const parsed = parseWorkBuddyEncryptedField(envelopeField());
    expect(parsed).toBeDefined();
    expect(parsed?.suite).toBe(1);
    expect(parsed?.keyId).toBe('9127dea1b44020a3');
    expect(parsed?.nonce.length).toBe(12);
    expect(parsed?.authTag.length).toBe(16);
    expect(parsed?.ciphertext.toString('utf8')).toBe('hello');
  });

  it('非加密字段返回 undefined', () => {
    expect(parseWorkBuddyEncryptedField({ a: 1 })).toBeUndefined();
    expect(parseWorkBuddyEncryptedField('plain')).toBeUndefined();
    expect(parseWorkBuddyEncryptedField(null)).toBeUndefined();
  });

  it('不支持的 suite 抛错', () => {
    expect(parseWorkBuddyEncryptedField(envelopeField({ suite: 2 }))).toBeUndefined();
  });

  it('nonce 长度不对返回 undefined', () => {
    const tooShort = Buffer.alloc(8, 1).toString('base64');
    expect(parseWorkBuddyEncryptedField(envelopeField({ nonce: tooShort }))).toBeUndefined();
  });

  it('authTag 长度不对返回 undefined', () => {
    const tooShort = Buffer.alloc(8, 2).toString('base64');
    expect(parseWorkBuddyEncryptedField(envelopeField({ authTag: tooShort }))).toBeUndefined();
  });

  it('keyId 不是 16 hex 字符返回 undefined', () => {
    expect(parseWorkBuddyEncryptedField(envelopeField({ keyId: 'short' }))).toBeUndefined();
    expect(parseWorkBuddyEncryptedField(envelopeField({ keyId: 'NOT-HEX-CHAR-16' }))).toBeUndefined();
  });

  it('keyId 是大写 hex 也接受（统一 lowercase）', () => {
    const parsed = parseWorkBuddyEncryptedField(envelopeField({ keyId: 'ABCDEF1234567890' }));
    expect(parsed?.keyId).toBe('abcdef1234567890');
  });

  it('envelope base64 解不开返回 undefined', () => {
    expect(parseWorkBuddyEncryptedField({ $wbEncrypted: 1, envelope: '!!!not-base64!!!' })).toBeUndefined();
  });

  it('envelope JSON 解析失败返回 undefined', () => {
    expect(parseWorkBuddyEncryptedField({
      $wbEncrypted: 1,
      envelope: Buffer.from('not json', 'utf8').toString('base64'),
    })).toBeUndefined();
  });

  it('ciphertext 为空返回 undefined', () => {
    expect(parseWorkBuddyEncryptedField(envelopeField({ ciphertext: '' }))).toBeUndefined();
  });
});