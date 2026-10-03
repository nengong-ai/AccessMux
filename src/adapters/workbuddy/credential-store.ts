import { SharedWork } from '../../util/abort.js';
// WorkBuddy credential store（端口 spec §4.3.2 + §7.1 + dsh-workbuddy-connect/
// auth.ts:375-501）。
//
// 关键不变量（D4 + D11 + 任务包验收 #2/#3）：
// 1. 凭据在 daemon 进程内短路径持有；不承诺独立凭据进程或物理擦除
// 2. own copy 落盘按 variant 分文件：`$XDG_CONFIG_HOME/accessmux/.workbuddy-auth.<variant>.json`
// 3. own copy 文件权限 0o600、目录权限 0o700
// 4. 单飞 refresh：并发 resolve() 只触发一次 refreshNow
// 5. refresh 失败 + access token 还有 > 30s 余量 → 仍返回当前 token；
//    真正过期才抛错让上层重登
// 6. 解密失败时不静默 fallback；走原 envelope 抛错
// 7. 选中账号后该账号消失绝不静默 fallback（避免把算错账户）

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileSync } from '../../util/private-file.js';
import { redactLogText } from '../../util/redact.js';
import { join } from 'node:path';
import { accessmuxConfigHome } from '../../config/paths.js';
import type { WorkBuddyVariant } from './variant.js';
import type { WorkBuddyKeyProvider } from './key-provider.js';
import { parseWorkBuddyEncryptedField } from './desktop-cred-envelope.js';
import { decryptWorkBuddyField } from './desktop-cred-decrypt.js';
import { parseWorkBuddyCredentialFile } from './parse-credential.js';
import { refreshWorkBuddyCredential } from './refresh.js';
import { workBuddyAuthCandidates } from './paths.js';

const OWN_PREFIX = '.workbuddy-auth';
export const WORKBUDDY_AUTH_OWN_VERSION = 1 as const;
/** 桌面凭据文件的显式覆盖入口（对齐 dsh auth.ts:90 WORKBUDDY_AUTH_FILE_ENV）。 */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE';

export interface WorkBuddyCredential {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  userId: string;
  nickname?: string;
  host?: string;
  endpoint?: string;
  userRegion?: string;
  enterpriseId?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  variant: WorkBuddyVariant;
  source: 'desktop' | 'accessmux';
}

export interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export interface WorkBuddyCredentialStoreOptions {
  /** variant 过滤：MVP 默认 'cn'。 */
  variant?: WorkBuddyVariant;
  /** atRest key provider；测试可注入 fake。 */
  keyProvider: WorkBuddyKeyProvider;
  /** 显式 desktop file path（测试用）。 */
  desktopPath?: string;
  /** 显式 own copy path（测试用）。 */
  ownPath?: string;
  /** refresh 函数；调用方注入以避免本文件 import refresh.ts 形成环。 */
  refresh: (credential: WorkBuddyCredential, signal?: AbortSignal) => Promise<WorkBuddyRefreshOutcome>;
  /** 到期前多久主动 refresh（默认 5 分钟）。 */
  refreshMarginMs?: number;
  /** fetch 实现（refresh 用；测试可注入）。 */
  fetchImpl?: typeof fetch;
  /** 文件系统钩子：测试可注入内存 FS。 */
  fs?: {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string) => string;
    writeFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: { recursive: boolean }) => void;
    rmSync: (p: string, opts: { force: boolean }) => void;
  };
}

export function workBuddyAccountId(credential: Pick<WorkBuddyCredential, 'variant' | 'userId'>): string {
  return createHash('sha256').update(`${credential.variant}\0${credential.userId}`).digest('hex').slice(0, 24);
}

function workBuddyOwnAuthPath(variant: WorkBuddyVariant): string {
  return join(accessmuxConfigHome(), `${OWN_PREFIX}.${variant}.json`);
}

const defaultFs = {
  existsSync: existsSync as (p: string) => boolean,
  readFileSync: ((p: string) => readFileSync(p, 'utf8')) as (p: string) => string,
  writeFileSync: ((p: string, data: string) => writePrivateFileSync(p, data)) as (p: string, data: string) => void,
  mkdirSync: ((p: string, opts: { recursive: boolean }) => mkdirSync(p, opts)) as (p: string, opts: { recursive: boolean }) => void,
  rmSync: ((p: string, opts: { force: boolean }) => rmSync(p, opts)) as (p: string, opts: { force: boolean }) => void,
};

interface OwnDocument {
  version: number;
  credential: WorkBuddyCredential;
}

function serializeOwn(credential: WorkBuddyCredential): string {
  const doc: OwnDocument = { version: WORKBUDDY_AUTH_OWN_VERSION, credential };
  return JSON.stringify(doc);
}

function parseOwn(text: string, variant: WorkBuddyVariant): WorkBuddyCredential | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<OwnDocument>;
    if (parsed.version !== WORKBUDDY_AUTH_OWN_VERSION) return undefined;
    const c = parsed.credential;
    if (typeof c !== 'object' || c === null) return undefined;
    if (c.variant !== variant) return undefined;
    if (typeof c.accessToken !== 'string' || c.accessToken === '') return undefined;
    if (typeof c.userId !== 'string') return undefined;
    return c as WorkBuddyCredential;
  } catch {
    return undefined;
  }
}

export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant;
  private readonly keyProvider: WorkBuddyKeyProvider;
  private readonly desktopPathExplicit: string | undefined;
  private readonly ownPathExplicit: string | undefined;
  private readonly refresh: (c: WorkBuddyCredential, signal?: AbortSignal) => Promise<WorkBuddyRefreshOutcome>;
  private readonly refreshMarginMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fs: NonNullable<WorkBuddyCredentialStoreOptions['fs']>;
  private accountId: string | undefined;
  private refreshWork = new SharedWork<WorkBuddyCredential>();
  private generation = 0;

  constructor(options: WorkBuddyCredentialStoreOptions) {
    this.variant = options.variant ?? 'cn';
    this.keyProvider = options.keyProvider;
    this.desktopPathExplicit = options.desktopPath;
    this.ownPathExplicit = options.ownPath;
    this.refresh = options.refresh;
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fs = options.fs ?? defaultFs;
  }

  /** 探测登录态：never throws；异常透出为 signed-out + reason（对齐 dsh auth.ts:445-461）。 */
  async status(signal?: AbortSignal): Promise<{ state: 'signed-in' | 'signed-out'; variant: WorkBuddyVariant; expiresAtMs?: number; source?: WorkBuddyCredential['source']; reason?: string }> {
    try {
      const credential = await this.current(signal);
      return credential === undefined
        ? { state: 'signed-out', variant: this.variant }
        : { state: 'signed-in', variant: this.variant, expiresAtMs: credential.expiresAtMs, source: credential.source };
    } catch (error: unknown) {
      // 解密失败 / spawn 失败 / 文件损坏是"可诊断的登出态"，不是静默的：
      // 状态只交安全提示，不回显未知文件内容或底层异常。
      return { state: 'signed-out', variant: this.variant, reason: 'WorkBuddy credential could not be read or decrypted; sign in again' };
    }
  }

  /**
   * 当前选中账号（resolve 解出来的）。选中账号消失绝不静默 fallback。
   */
  async current(signal?: AbortSignal): Promise<WorkBuddyCredential | undefined> {
    signal?.throwIfAborted();
    let desktopCredential: WorkBuddyCredential | undefined;
    for (const desktopPath of this.desktopCandidates()) {
      if (!this.fs.existsSync(desktopPath)) continue;
      desktopCredential = await this.readDesktop(desktopPath, signal);
      if (desktopCredential !== undefined) break;
    }
    const ownPath = this.ownAuthPath();
    let ownCredential: WorkBuddyCredential | undefined;
    if (this.fs.existsSync(ownPath)) {
      try {
        ownCredential = parseOwn(this.fs.readFileSync(ownPath), this.variant);
      } catch {
        ownCredential = undefined;
      }
    }
    const candidates = [desktopCredential, ownCredential].filter(
      (c): c is WorkBuddyCredential => c !== undefined && c.variant === this.variant,
    );
    const selected = this.accountId ?? (desktopCredential === undefined ? undefined : workBuddyAccountId(desktopCredential));
    const sameAccount = selected === undefined ? candidates : candidates.filter((c) => workBuddyAccountId(c) === selected);
    return sameAccount.reduce<WorkBuddyCredential | undefined>((best, c) =>
      best === undefined || c.expiresAtMs > best.expiresAtMs ? c : best, undefined);
  }

  /**
   * 解析出可用凭据：access token 未到期直接返回；剩不到 refreshMarginMs
   * 时触发 refresh，单飞（并发 resolve 只调一次 refreshNow）。
   */
  async resolve(signal?: AbortSignal): Promise<WorkBuddyCredential> {
    signal?.throwIfAborted();
    const credential = await this.current(signal);
    signal?.throwIfAborted();
    if (credential === undefined) {
      const candidates = this.desktopCandidates();
      throw new Error(
        `workbuddy: no signed-in account found (desktop candidates: ${candidates.length > 0 ? candidates.join(', ') : 'none on this platform'}; own copy: ${this.ownAuthPath()})`,
      );
    }
    if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential;
    const generation = this.generation;
    return this.refreshWork.run(ownedSignal => this.refreshNow(credential, generation, ownedSignal), signal).catch(error => {
      if (signal?.aborted) throw new Error('Credential refresh cancelled');
      throw error;
    });
  }

  selectAccount(accountId: string | undefined): void {
    this.generation++;
    this.accountId = accountId;
    this.refreshWork.cancel();
    this.refreshWork = new SharedWork<WorkBuddyCredential>();
  }

  /** Drop cached key references; does not promise physical JS string erasure. */
  dispose(): void {
    this.generation++;
    this.keyProvider.resetCache();
    this.refreshWork.cancel();
    this.refreshWork = new SharedWork<WorkBuddyCredential>();
  }

  /** 登出：清掉本 variant 名下 own copy；不动 desktop。 */
  async logout(): Promise<void> {
    this.dispose();
    const ownPath = this.ownAuthPath();
    this.fs.rmSync(ownPath, { force: true });
    this.fs.rmSync(`${ownPath}.lock`, { force: true });
  }

  ownAuthPath(): string {
    return this.ownPathExplicit ?? workBuddyOwnAuthPath(this.variant);
  }

  /**
   * desktop 凭据文件候选（对齐 dsh auth.ts:343-355 的配置优先级）：
   * 显式注入 → `WORKBUDDY_AUTH_FILE` 环境变量 → 平台默认候选（按 variant 过滤）。
   * 存在性由 current() 的 existsSync + readDesktop 的 ENOENT 语义兜底。
   */
  desktopCandidates(): string[] {
    if (this.desktopPathExplicit !== undefined) return [this.desktopPathExplicit];
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return [fromEnv.trim()];
    return workBuddyAuthCandidates()
      .filter((candidate) => candidate.variant === this.variant)
      .map((candidate) => candidate.path);
  }

  /** 第一个 desktop 候选（诊断用；与 current() 的读取起点一致）。 */
  desktopPath(): string | undefined {
    return this.desktopCandidates()[0];
  }

  private async readDesktop(desktopPath: string, signal?: AbortSignal): Promise<WorkBuddyCredential | undefined> {
    let text: string;
    try {
      text = this.fs.readFileSync(desktopPath);
    } catch (error: unknown) {
      // 对齐 dsh auth.ts:527-535：只有"文件不存在"（ENOENT，含 existsSync
      // 与 read 之间的竞态）落到下一候选；其他 IO 错误（权限等）抛出，
      // 带路径与底层 cause。
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
      throw new Error(
        `workbuddy-desktop.info read failed at ${desktopPath}: ${redactLogText((error as NodeJS.ErrnoException).code ?? 'unreadable')}`,
      );
    }
    const parsed = parseWorkBuddyCredentialFile(text);
    const atRest = await this.keyProvider.resolveAtRestSecretKey(signal);
    const accessField = parseWorkBuddyEncryptedField(parsed.accessTokenEnvelope);
    if (accessField === undefined) {
      throw new Error('workbuddy-desktop.info accessToken envelope is not parseable');
    }
    const accessToken = decryptWorkBuddyField(accessField, atRest.atRestSecretKey);
    let refreshToken: string | undefined;
    if (parsed.refreshTokenEnvelope !== undefined) {
      const field = parseWorkBuddyEncryptedField(parsed.refreshTokenEnvelope);
      if (field !== undefined) refreshToken = decryptWorkBuddyField(field, atRest.atRestSecretKey);
    }
    // 5.6+ 文件结构不暴露 idToken；保留接口供未来版本扩展
    const credential: WorkBuddyCredential = {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      userId: parsed.uid,
      ...(parsed.host === undefined ? {} : { host: parsed.host }),
      ...(parsed.enterpriseId === undefined ? {} : { enterpriseId: parsed.enterpriseId }),
      expiresAtMs: parsed.expiresAtMs,
      ...(parsed.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: parsed.refreshExpiresAtMs }),
      variant: this.variant,
      source: 'desktop',
    };
    return credential;
  }

  /**
   * 主动 refresh 一次：成功后写 own copy；失败时若 access token 还有 > 30s
   * 余量就保留当前 token（graceful），真正过期才抛错让用户重登。
   */
  private async refreshNow(credential: WorkBuddyCredential, generation: number, signal?: AbortSignal): Promise<WorkBuddyCredential> {
    if (
      credential.refreshToken === undefined
      || (credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= Date.now())
    ) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential;
      throw new Error('workbuddy: access token expired and no valid refresh token is available; sign in again in WorkBuddy');
    }
    try {
      const outcome = await this.refresh(credential, signal);
      signal?.throwIfAborted();
      if (this.generation !== generation) throw new Error('Credential refresh was reset');
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresAtMs,
        source: 'accessmux',
      };
      const ownPath = this.ownAuthPath();
      if (this.fs !== defaultFs) this.fs.mkdirSync(dirname(ownPath), { recursive: true });
      this.fs.writeFileSync(ownPath, serializeOwn(refreshed));
      return refreshed;
    } catch (error: unknown) {
      if (this.generation !== generation) throw new Error('Credential refresh was reset');
      if (signal?.aborted) throw new Error('Credential refresh cancelled');
      if (credential.expiresAtMs > Date.now() + 30_000) return credential;
      throw new Error(
        `workbuddy: token refresh failed and access token is expired (${safeCredentialError(error, credential)}); sign in again in WorkBuddy`,
      );
    }
  }

  /** 包装 refresh 函数：把 store 拿到的 credential 喂给 refresh 模块，注入 fetchImpl。 */
  static defaultRefresh(credential: WorkBuddyCredential, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<WorkBuddyRefreshOutcome> {
    return refreshWorkBuddyCredential(credential, fetchImpl, signal) as Promise<WorkBuddyRefreshOutcome>;
  }
}
/** Redact exact current secrets before generic text rules (including short tokens). */
export function safeCredentialError(text: unknown, credential: Partial<WorkBuddyCredential>): string {
  let out = String(text instanceof Error ? text.message : text);
  const secrets = [credential.accessToken, credential.refreshToken, credential.idToken].filter((s): s is string => typeof s === 'string' && s !== '').sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  return redactLogText(out);
}
