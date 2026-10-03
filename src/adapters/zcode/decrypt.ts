// Copyright 2026 Z.AI Co., Ltd. Licensed under Apache-2.0.
// Modified by AccessMux contributors: dependency injection/API adaptation and
// safe diagnostic rewriting; derived from ZCode credential-cipher.ts.
// License: docs/third-party-licenses/ZCode-Apache-2.0.txt; attribution: NOTICE.
// ZCode 凭据解密（T019，R014 §1.2-2 合同）。
// `~/.zcode/v2/credentials.json` 的值是 `enc:v1:<iv>.<authtag>.<ciphertext>`
// （base64url），AES-256-GCM；密钥 = sha256(secret)，secret 优先取
// `ZCODE_CREDENTIAL_SECRET` env，否则官方 fallback 公式
// `zcode-credential-fallback:<platform>:<homedir>:<username>`。
// 逐行对照开源仓库 apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts
// （clone @ 872ad96）；只移植 decrypt + encrypt（测试自证用），不引入其他行为。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';

const ENCRYPTED_VALUE_PREFIX = 'enc:v1:';
const CREDENTIAL_CIPHER_ALGORITHM = 'aes-256-gcm';
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET';

export interface ZcodeCipherDeps {
  env?: Record<string, string | undefined>;
  /** 覆盖 os.homedir()/userInfo()（测试注入）。 */
  home?: string;
  username?: string;
}

export function isEncryptedZcodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

/** 官方 fallback secret（credential-cipher.ts:87-101 原式）。 */
export function zcodeCredentialFallbackSecret(deps: ZcodeCipherDeps = {}): string {
  let username = 'unknown';
  if (deps.username !== undefined) username = deps.username;
  else {
    try {
      username = userInfo().username;
    } catch {
      // 官方同款：解析不出用户名时退 "unknown"
    }
  }
  return `zcode-credential-fallback:${platform()}:${deps.home ?? homedir()}:${username}`;
}

export interface ZcodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export function createZcodeCredentialCipher(deps: ZcodeCipherDeps = {}): ZcodeCredentialCipher {
  const env = deps.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  const secret = configuredSecret !== undefined && configuredSecret !== ''
    ? configuredSecret
    : zcodeCredentialFallbackSecret(deps);
  const key = createHash('sha256').update(secret).digest();

  return {
    decrypt(value: string): string {
      if (!isEncryptedZcodeCredentialValue(value)) return value;
      const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split('.');
      const [ivRaw, authTagRaw, cipherRaw] = parts;
      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw new Error('zcode 凭据解密失败：ciphertext 格式不合法');
      }
      const iv = Buffer.from(ivRaw, 'base64url');
      const authTag = Buffer.from(authTagRaw, 'base64url');
      const cipherText = Buffer.from(cipherRaw, 'base64url');
      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw new Error('zcode 凭据解密失败：IV 长度不对');
      }
      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw new Error('zcode 凭据解密失败：auth tag 长度不对');
      }
      try {
        const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf-8');
      } catch (error) {
        throw new Error('zcode 凭据解密失败：密钥不匹配或密文损坏', { cause: error });
      }
    },
    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
      return [
        ENCRYPTED_VALUE_PREFIX,
        iv.toString('base64url'),
        '.',
        cipher.getAuthTag().toString('base64url'),
        '.',
        encrypted.toString('base64url'),
      ].join('');
    },
  };
}
