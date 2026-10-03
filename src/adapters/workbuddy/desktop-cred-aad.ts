// WorkBuddy 解密 AAD 构造（端口 spec §7.1 + dsh-workbuddy-connect/
// desktop-credential-protection.ts:219-241）。
//
// 关键：length-prefix 是 **4 字节 BE-u32 长度前缀**（不是 1 字节单字节前缀）。
// spec 文档原写「length-prefix」字面理解有歧义；dsh 真实源码以
// `header.writeUInt32BE(bytes.length)` 实现。AccessMux 三轮返工因 1-byte
// vs 4-byte 长度前缀错位 9 字节，AAD 总长实测 54 字节（不是 45 / 46）。
//
// 字节布局：
//   7 B   'WB-AAD\0'
//   1 B   0x01
//   9 B   BE-u32(5) + 'WBEV1'                   (length-prefix)
//  10 B   BE-u32(6) + 'sym-v1'                  (length-prefix)
//   4 B   BE-u32(suite=1)
//  20 B   BE-u32(16) + keyId (16 hex chars ASCII)
//   1 B   0x02
//   1 B   0x00
//   1 B   0x00
// total: 54 bytes
//
// 真机验证（WorkBuddy 5.6.2 macOS）：6 种 key/AAD 组合 round-trip 唯一能解出的
// 是 utf8-of-string key + 54-byte AAD；其余 5 种 keyId 不匹配或 GCM auth failed。

import type { WorkBuddyEncryptedField } from './desktop-cred-envelope.js';

const AAD_PREFIX = new TextEncoder().encode('WB-AAD\0');
const SUITE_TAG = new TextEncoder().encode('WBEV1');
const KEY_TYPE_TAG = new TextEncoder().encode('sym-v1');

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function beU32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`BE-u32 value out of range: ${value}`);
  }
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function lengthPrefixBeU32(bytes: Uint8Array): Uint8Array {
  return concat([beU32(bytes.length), bytes]);
}

/**
 * 构造 WB-AAD 字节序列。54 字节；与 dsh-workbuddy-connect 0.6.5 实测一致。
 *
 * keyId 作为 16 字节 UTF-8（hex 字符串）写入，不再 hex-decoded。
 */
export function buildAuthenticatedContextAad(field: WorkBuddyEncryptedField): Uint8Array {
  const keyIdBytes = new TextEncoder().encode(field.keyId);
  return concat([
    AAD_PREFIX,
    new Uint8Array([0x01]),
    lengthPrefixBeU32(SUITE_TAG),
    lengthPrefixBeU32(KEY_TYPE_TAG),
    beU32(field.suite),
    lengthPrefixBeU32(keyIdBytes),
    new Uint8Array([0x02]),
    new Uint8Array([0x00]),
    new Uint8Array([0x00]),
  ]);
}