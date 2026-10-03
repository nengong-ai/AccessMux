// WorkBuddy AAD 字节序构造（端口 spec §7.1 + dsh-workbuddy-connect/
// desktop-credential-protection.ts:219-241）。
//
// 关键不变量（dsh 真实源码验证，三轮返工校正）：
// - AAD 总长 54 字节
// - 前缀 'WB-AAD\0'（7 字节）
// - length-prefix 是 **4 字节 BE-u32**（不是 1 字节单字节前缀）
// - 含 suite (BE-u32=1) / keyId (16 hex chars 作为 16 ASCII bytes) / WBEV1 / sym-v1 字面量
//
// 字节布局：
//   0-6     'WB-AAD\0' (7 bytes)
//   7       0x01
//   8-16    BE-u32(5) + 'WBEV1'          (length-prefixed)
//   17-26   BE-u32(6) + 'sym-v1'         (length-prefixed)
//   27-30   BE-u32(suite=1)
//   31-50   BE-u32(16) + keyId UTF-8     (length-prefixed)
//   51      0x02
//   52      0x00
//   53      0x00

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { buildAuthenticatedContextAad } from '../../../src/adapters/workbuddy/desktop-cred-aad.js';
import type { WorkBuddyEncryptedField } from '../../../src/adapters/workbuddy/desktop-cred-envelope.js';

function makeField(keyIdHex: string): WorkBuddyEncryptedField {
  return {
    suite: 1,
    keyId: keyIdHex,
    nonce: Buffer.alloc(12),
    authTag: Buffer.alloc(16),
    ciphertext: Buffer.from('x'),
  };
}

function beU32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

describe('buildAuthenticatedContextAad', () => {
  it('输出总长 54 字节（dsh 真实源码验证）', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(aad.length).toBe(54);
  });

  it('前缀 7 字节 = WB-AAD\\0', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(Buffer.from(aad.subarray(0, 7)).toString('utf8')).toBe('WB-AAD\0');
  });

  it('第 7 字节固定 0x01', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(aad[7]).toBe(0x01);
  });

  it('WBEV1 length-prefix：BE-u32(5) + WBEV1（offset 8-16）', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(Array.from(aad.subarray(8, 12))).toEqual(beU32(5));
    expect(Buffer.from(aad.subarray(12, 17)).toString('utf8')).toBe('WBEV1');
  });

  it('sym-v1 length-prefix：BE-u32(6) + sym-v1（offset 17-26）', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(Array.from(aad.subarray(17, 21))).toEqual(beU32(6));
    expect(Buffer.from(aad.subarray(21, 27)).toString('utf8')).toBe('sym-v1');
  });

  it('suite BE-u32 = [0x00, 0x00, 0x00, 0x01]（offset 27-30）', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(Array.from(aad.subarray(27, 31))).toEqual(beU32(1));
  });

  it('keyId length-prefix：BE-u32(16) + 16 ASCII bytes（offset 31-50）', () => {
    const keyId = '9127dea1b44020a3';
    const aad = buildAuthenticatedContextAad(makeField(keyId));
    expect(Array.from(aad.subarray(31, 35))).toEqual(beU32(16));
    expect(Buffer.from(aad.subarray(35, 51)).toString('utf8')).toBe(keyId);
  });

  it('尾部固定 [0x02, 0x00, 0x00]（offset 51-54）', () => {
    const aad = buildAuthenticatedContextAad(makeField('9127dea1b44020a3'));
    expect(Array.from(aad.subarray(51, 54))).toEqual([0x02, 0x00, 0x00]);
  });

  it('不同 keyId 只改 [35..51] 这 16 字节；其余位不变', () => {
    const a1 = buildAuthenticatedContextAad(makeField('0000000000000000'));
    const a2 = buildAuthenticatedContextAad(makeField('ffffffffffffffff'));
    expect(a1.length).toBe(54);
    expect(a2.length).toBe(54);
    for (let i = 0; i < 54; i++) {
      if (i >= 35 && i < 51) continue; // keyId 区域应当不同
      expect(a1[i]).toBe(a2[i]);
    }
    expect(Buffer.from(a1.subarray(35, 51)).toString('utf8')).toBe('0000000000000000');
    expect(Buffer.from(a2.subarray(35, 51)).toString('utf8')).toBe('ffffffffffffffff');
  });
});