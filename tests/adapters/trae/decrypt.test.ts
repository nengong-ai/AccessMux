// Trae AES-128-CBC 自实现 + CLI JWT 解析测试。
//
// SALT 常量是协议事实，测试只验证加密/解密往返；不依赖真实桌面安装。

import { describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { decryptTraeStorageValue, parseTraeAuthValue, parseTraeCliToken, parseTraeStorageDocument, TRAE_AUTH_STORAGE_KEY } from '../../../src/adapters/trae/decrypt.js';

const SALT_A = Buffer.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const SALT_B = Buffer.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);

function xorBuf(a: Buffer, b: Buffer): Buffer {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}

function encryptTraeValue(plaintext: string): string {
  const random = randomBytes(32);
  const salt = xorBuf(SALT_A, SALT_B);
  const first = createHash('sha512').update(random).digest();
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest();
  const key = derived.subarray(0, 16);
  const iv = derived.subarray(16, 32);
  const ptBuffer = Buffer.from(plaintext, 'utf8');
  const digest = createHash('sha512').update(ptBuffer).digest();
  const payload = Buffer.concat([digest, ptBuffer]);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  // header: 74 63 05 10 00 00
  const header = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
  return Buffer.concat([header, random, encrypted]).toString('base64');
}

describe('decryptTraeStorageValue', () => {
  it('合法 AES 加密往返', () => {
    const plaintext = JSON.stringify({ token: 'tkn', userId: 'u1' });
    const encoded = encryptTraeValue(plaintext);
    expect(decryptTraeStorageValue(encoded)).toBe(plaintext);
  });

  it('短 buffer 报错', () => {
    expect(() => decryptTraeStorageValue('aGVsbG8=')).toThrow(/too short/);
  });

  it('未知 header 报错', () => {
    const bogus = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6]), randomBytes(100)]).toString('base64');
    expect(() => decryptTraeStorageValue(bogus)).toThrow(/unsupported Trae auth encryption header/);
  });
});

describe('parseTraeAuthValue / parseTraeStorageDocument', () => {
  it('明文 JSON 不解密直接解析', () => {
    expect(parseTraeAuthValue('{"token":"x"}')).toEqual({ token: 'x' });
  });

  it('加密值解密后解析', () => {
    const plaintext = JSON.stringify({ token: 'enc-tok', userId: 'u2' });
    const encoded = encryptTraeValue(plaintext);
    expect(parseTraeAuthValue(encoded)).toEqual({ token: 'enc-tok', userId: 'u2' });
  });

  it('storage.json 解出 iCubeAuthInfo 键下的凭据', () => {
    const plaintext = JSON.stringify({ token: 'tkn', userId: 'u3' });
    const encoded = encryptTraeValue(plaintext);
    const document = JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: encoded });
    expect(parseTraeStorageDocument(document)).toEqual({ token: 'tkn', userId: 'u3' });
  });

  it('storage.json 缺 key 时报错', () => {
    expect(() => parseTraeStorageDocument('{}')).toThrow(/has no/);
  });
});

describe('parseTraeCliToken', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
  }

  it('裸 JWT 解出 accessToken + userId + expiresAtMs', () => {
    const jwt = makeJwt({ data: { user_id: 'cli-user' }, exp: 1_900_000_000 });
    expect(parseTraeCliToken(jwt)).toEqual({
      accessToken: jwt,
      userId: 'cli-user',
      expiresAtMs: 1_900_000_000 * 1000,
    });
  });

  it('JSON envelope 内含 token', () => {
    const jwt = makeJwt({ data: { user_id: 'cli-user2' } });
    const env = JSON.stringify({ token: jwt });
    expect(parseTraeCliToken(env)).toMatchObject({ accessToken: jwt, userId: 'cli-user2' });
  });

  it('JWT 缺 data.user_id 报错', () => {
    const jwt = makeJwt({});
    expect(() => parseTraeCliToken(jwt)).toThrow(/user_id/);
  });

  it('JWT 缺 exp 不报错（expiresAtMs undefined）', () => {
    const jwt = makeJwt({ data: { user_id: 'cli-user3' } });
    expect(parseTraeCliToken(jwt)).toEqual({ accessToken: jwt, userId: 'cli-user3' });
  });

  it('非三段 JWT 报错', () => {
    expect(() => parseTraeCliToken('a.b')).toThrow(/three-part JWT/);
  });

  it('空字符串报错', () => {
    expect(() => parseTraeCliToken('')).toThrow(/empty/);
  });
});