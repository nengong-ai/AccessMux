// WorkBuddy workbuddy-desktop.info 解析（三轮返工校正）。
// 真机结构：top-level { account, auth, accounts, allAccounts }；token 在 auth.accessToken。

import { describe, expect, it } from 'vitest';
import { parseWorkBuddyCredentialFile } from '../../../src/adapters/workbuddy/parse-credential.js';

function buildEncryptedEnvelope(atRestKey: string, plaintext: string): unknown {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const key = crypto.createHash('sha256').update(atRestKey, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const nonce = crypto.randomBytes(12);
  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0'),
    Buffer.from([0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x05]),
    Buffer.from('WBEV1'),
    Buffer.from([0x00, 0x00, 0x00, 0x06]),
    Buffer.from('sym-v1'),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from(keyId, 'utf8'),
    Buffer.from([0x02, 0x00, 0x00]),
  ]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
  };
}

function buildRealShapeFile(args: {
  uid: string;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  domain?: string;
}): unknown {
  const accessEnvelope = buildEncryptedEnvelope('at-rest', args.accessToken);
  const refreshEnvelope = args.refreshToken === undefined ? undefined : buildEncryptedEnvelope('at-rest', args.refreshToken);
  return {
    account: {
      uid: args.uid,
      nickname: buildEncryptedEnvelope('at-rest', 'tester'),
      uin: '330107779397',
      type: 'personal',
    },
    auth: {
      accessToken: accessEnvelope,
      ...(refreshEnvelope === undefined ? {} : { refreshToken: refreshEnvelope }),
      tokenType: 'Bearer',
      expiresAt: args.expiresAtMs,
      ...(args.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: args.refreshExpiresAtMs }),
      ...(args.domain === undefined ? {} : { domain: args.domain }),
      scope: 'openid profile offline_access email',
    },
    accounts: [],
    allAccounts: [],
  };
}

describe('parseWorkBuddyCredentialFile (5.6+ real shape)', () => {
  it('合法 5.6+ 文件解析出 uid / accessTokenEnvelope / expiresAtMs / host', () => {
    const expires = 1893456000000;
    const refreshExpires = 1896060000000;
    const file = buildRealShapeFile({
      uid: 'f3921708-8c0e-4a1c-8d86-f958c42a9556',
      accessToken: 'jwt.access',
      refreshToken: 'jwt.refresh',
      expiresAtMs: expires,
      refreshExpiresAtMs: refreshExpires,
      domain: 'www.codebuddy.cn',
    });
    const parsed = parseWorkBuddyCredentialFile(JSON.stringify(file));
    expect(parsed.uid).toBe('f3921708-8c0e-4a1c-8d86-f958c42a9556');
    expect(parsed.accessTokenEnvelope).toBeDefined();
    expect(parsed.refreshTokenEnvelope).toBeDefined();
    expect(parsed.expiresAtMs).toBe(expires);
    expect(parsed.refreshExpiresAtMs).toBe(refreshExpires);
    expect(parsed.host).toBe('www.codebuddy.cn');
    expect(parsed.nicknameEnvelope).toBeDefined();
    expect(parsed.hasEncryptedFields).toBe(true);
  });

  it('expiresAt 缺失时 0（让上层视为需 refresh）', () => {
    const file = buildRealShapeFile({
      uid: 'u',
      accessToken: 'tok',
    });
    const parsed = parseWorkBuddyCredentialFile(JSON.stringify(file));
    expect(parsed.expiresAtMs).toBe(0);
    expect(parsed.refreshExpiresAtMs).toBeUndefined();
    expect(parsed.host).toBeUndefined();
  });

  it('refresh token 可选；缺失时不写 refreshTokenEnvelope', () => {
    const file = buildRealShapeFile({ uid: 'u', accessToken: 'tok' });
    const parsed = parseWorkBuddyCredentialFile(JSON.stringify(file));
    expect(parsed.refreshTokenEnvelope).toBeUndefined();
  });

  it('JSON 非法抛错', () => {
    expect(() => parseWorkBuddyCredentialFile('not json')).toThrow(/not valid JSON/);
  });

  it('不是对象抛错', () => {
    expect(() => parseWorkBuddyCredentialFile('[]')).toThrow(/JSON object/);
  });

  it('account 缺失抛错', () => {
    expect(() => parseWorkBuddyCredentialFile('{}')).toThrow(/missing account/);
  });

  it('uid 缺失抛错', () => {
    const file = { account: {}, auth: { accessToken: buildEncryptedEnvelope('k', 'x') } };
    expect(() => parseWorkBuddyCredentialFile(JSON.stringify(file))).toThrow(/uid/);
  });

  it('auth 缺失抛错', () => {
    const file = { account: { uid: 'u' } };
    expect(() => parseWorkBuddyCredentialFile(JSON.stringify(file))).toThrow(/auth\.accessToken/);
  });

  it('accessToken 缺失抛错', () => {
    const file = { account: { uid: 'u' }, auth: {} };
    expect(() => parseWorkBuddyCredentialFile(JSON.stringify(file))).toThrow(/auth\.accessToken/);
  });

  it('hasEncryptedFields 仅在至少一个字段是 envelope 时为 true', () => {
    const file = {
      account: { uid: 'u' },
      auth: { accessToken: { plain: 'not-encrypted' } },
    };
    const parsed = parseWorkBuddyCredentialFile(JSON.stringify(file));
    expect(parsed.hasEncryptedFields).toBe(false);
  });

  it('expiresAt 是 ms 数字时识别（auth.expiresAt 形态）', () => {
    const file = {
      account: { uid: 'u' },
      auth: { accessToken: buildEncryptedEnvelope('k', 'x'), expiresAt: 1893456000000 },
    };
    const parsed = parseWorkBuddyCredentialFile(JSON.stringify(file));
    expect(parsed.expiresAtMs).toBe(1893456000000);
  });
});