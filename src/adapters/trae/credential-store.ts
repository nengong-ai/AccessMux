import { SharedWork } from '../../util/abort.js';
// Trae 凭据 store（端口 spec §3.2.3 + §3.2.4 + §4.3.3 + §7.3）。
//
// 关键不变量（D11 + 任务包验收 2/3）：
// 1. 双区域 store 互不污染：每 region 一个独立 store，candidate 列表里
//    region 不匹配的 account 直接被 matchesRegion() 过滤掉
// 2. own copy 落盘按 region 分文件：`$XDG_CONFIG_HOME/accessmux/.trae-auth.<region>.json`
// 3. 真实桌面凭据只活在本进程内；own copy 文件权限 0o600、目录权限 0o700
// 4. 单飞 refresh：并发 resolve() 只触发一次 refreshNow
// 5. refresh 失败 + access token 未到期（> 30s 余量）→ 仍返回当前 token；
//    真实过期才抛错让上层重登
// 6. 选中账号后该账号消失绝不静默 fallback（避免把算错账户）

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileSync } from '../../util/private-file.js';
import { redactLogText } from '../../util/redact.js';
import { parseTraeCliToken, parseTraeStorageDocument } from './decrypt.js';
import type { TraeEdition, TraeStorageCandidate } from './paths.js';
import { traeStorageCandidates } from './paths.js';
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.js';
import { legacyTraeOwnAuthPath, traeOwnAuthPath, TRAE_AUTH_OWN_VERSION } from './store-paths.js';

export interface TraeCredential {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  accountName?: string;
  host: string;
  /** `userRegion.region` claim：'CN' | 'SG'，可能小写。 */
  userRegion?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  edition: TraeEdition;
  source: 'desktop' | 'accessmux' | 'cli';
}

export interface TraeRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  host?: string;
}

export interface TraeCredentialStoreOptions {
  /** region 过滤：store 只看自己 region 的 account；双区域隔离的核心。 */
  region?: TraeRegion;
  /** edition 过滤：限定只扫某个 edition 的 candidate；默认 auto。 */
  edition?: TraeEdition | 'auto';
  /** 显式 own copy path（测试用）。 */
  ownPath?: string;
  /** 显式 legacy path（测试用）。 */
  legacyOwnPath?: string;
  /** refresh 函数；调用方注入以避免本文件 import refresh.ts 形成环。 */
  refresh: (credential: TraeCredential, signal?: AbortSignal) => Promise<TraeRefreshOutcome>;
  /** 到期前多久主动 refresh（默认 5 分钟）。 */
  refreshMarginMs?: number;
  /** 文件系统钩子：测试可注入内存 FS。 */
  fs?: {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string) => string;
    writeFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: { recursive: boolean }) => void;
    rmSync: (p: string, opts: { force: boolean }) => void;
  };
}

export interface TraeAccountChoice {
  id: string;
  accountName: string;
  edition: TraeEdition;
  region: TraeRegion;
  source: TraeCredential['source'];
  tokenExpiresAtMs: number;
  selected: boolean;
}

export interface TraeCandidateFailure {
  path: string;
  edition: TraeEdition;
  source: 'desktop' | 'cli';
  reason: 'missing' | 'unreadable' | 'invalid';
  message?: string;
}

/** CLI 凭据没有 host claim，用此默认值兜底（CN 端点）。 */
const CLI_DEFAULT_HOST = 'https://api.trae.cn';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function normalizeTraeCredential(
  raw: unknown,
  edition: TraeEdition,
  source: TraeCredential['source'],
): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken']);
  if (accessToken === undefined) return undefined;
  const expiresAtMs = timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0;
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt']);
  const refreshToken = optionalString(value['refreshToken']);
  const userRegion = userRegionOf(value['userRegion']);
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined;
  const accountName = optionalString(account?.['username']);
  const userId = optionalString(value['userId']) ?? '';
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    userId,
    ...(accountName === undefined ? {} : { accountName }),
    host: optionalString(value['host']) ?? '',
    ...(userRegion === undefined ? {} : { userRegion }),
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    edition,
    source,
  };
}

export function traeAccountId(credential: Pick<TraeCredential, 'edition' | 'userId' | 'accountName'>): string {
  const stable = `${credential.edition}\0${credential.userId || credential.accountName || 'unknown'}`;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

interface OwnDocument {
  version: number;
  credential: TraeCredential;
}

function parseOwn(text: string): TraeCredential | undefined {
  try {
    const document = JSON.parse(text) as Partial<OwnDocument>;
    if (document.version !== TRAE_AUTH_OWN_VERSION || typeof document.credential !== 'object' || document.credential === null) {
      return undefined;
    }
    const stored = document.credential as unknown as Record<string, unknown>;
    const edition = stored['edition'];
    if (edition !== 'cn' && edition !== 'sg' && edition !== 'solo' && edition !== 'solo-sg') return undefined;
    return normalizeTraeCredential({
      token: stored['accessToken'],
      refreshToken: stored['refreshToken'],
      userId: stored['userId'],
      host: stored['host'],
      userRegion: stored['userRegion'],
      account: stored['accountName'] === undefined ? undefined : { username: stored['accountName'] },
      expiredAt: stored['expiresAtMs'],
      refreshExpiredAt: stored['refreshExpiresAtMs'],
    }, edition, 'accessmux');
  } catch {
    return undefined;
  }
}

const defaultFs = {
  existsSync: existsSync as (p: string) => boolean,
  readFileSync: ((p: string) => readFileSync(p, 'utf8')) as (p: string) => string,
  writeFileSync: ((p: string, data: string) => writePrivateFileSync(p, data)) as (p: string, data: string) => void,
  mkdirSync: ((p: string, opts: { recursive: boolean }) => mkdirSync(p, opts)) as (p: string, opts: { recursive: boolean }) => void,
  rmSync: ((p: string, opts: { force: boolean }) => rmSync(p, opts)) as (p: string, opts: { force: boolean }) => void,
};

export class TraeCredentialStore {
  private readonly region: TraeRegion | undefined;
  private edition: TraeEdition | 'auto';
  private readonly ownPathExplicit: string | undefined;
  private readonly legacyOwnPathExplicit: string | undefined;
  private readonly refresh: (c: TraeCredential, signal?: AbortSignal) => Promise<TraeRefreshOutcome>;
  private readonly refreshMarginMs: number;
  private readonly fs: NonNullable<TraeCredentialStoreOptions['fs']>;
  private accountId: string | undefined;
  private storagePathOverride: string | undefined;
  private refreshWork = new SharedWork<TraeCredential>();
  private generation = 0;

  constructor(options: TraeCredentialStoreOptions) {
    this.region = options.region;
    this.edition = options.edition ?? 'auto';
    this.ownPathExplicit = options.ownPath;
    this.legacyOwnPathExplicit = options.legacyOwnPath;
    this.refresh = options.refresh;
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000;
    this.fs = options.fs ?? defaultFs;
  }

  /** region 过滤的核心：凭据 region 必须等于 store region。 */
  private matchesRegion(credential: TraeCredential): boolean {
    return this.region === undefined || regionOfCredential(credential) === this.region;
  }

  /** 此 store 写入的 own copy 路径（per-region 或 legacy）。 */
  ownAuthPath(): string {
    if (this.ownPathExplicit !== undefined) return this.ownPathExplicit;
    return this.region !== undefined ? traeOwnAuthPath(this.region) : legacyTraeOwnAuthPath();
  }

  /** 读取 own copy 的候选顺序（most-preferred first）。 */
  private ownCandidates(): string[] {
    if (this.ownPathExplicit !== undefined) {
      return this.legacyOwnPathExplicit !== undefined
        ? [this.ownPathExplicit, this.legacyOwnPathExplicit]
        : [this.ownPathExplicit];
    }
    if (this.region !== undefined) {
      return [traeOwnAuthPath(this.region), this.legacyOwnPathExplicit ?? legacyTraeOwnAuthPath()];
    }
    return [
      this.legacyOwnPathExplicit ?? legacyTraeOwnAuthPath(),
      traeOwnAuthPath('cn'),
      traeOwnAuthPath('ai'),
    ];
  }

  /** 候选 storage.json / CLI token 路径；edition 过滤后扫。 */
  candidates(): readonly TraeStorageCandidate[] {
    if (this.storagePathOverride !== undefined) {
      const edition = this.edition === 'auto' ? 'cn' : this.edition;
      return [
        { edition, path: this.storagePathOverride, source: 'desktop' },
        { edition, path: this.storagePathOverride, source: 'cli' },
      ];
    }
    const all = traeStorageCandidates();
    // 仅扫 desktop + CN CLI home（SG CLI 路径未验证，端口 spec §3.7 注）。
    return this.edition === 'auto'
      ? all.filter((c) => c.source === 'desktop' || c.edition === 'cn')
      : all.filter((c) => c.edition === this.edition && (c.source === 'desktop' || c.edition === 'cn'));
  }

  setSource(storagePath: string | undefined, edition: TraeEdition | 'auto' = 'auto'): void {
    this.generation++;
    this.storagePathOverride = storagePath;
    this.edition = edition;
    this.refreshWork.cancel();
    this.refreshWork = new SharedWork<TraeCredential>();
  }

  selectAccount(accountId: string | undefined): void {
    this.generation++;
    this.accountId = accountId;
    this.refreshWork.cancel();
    this.refreshWork = new SharedWork<TraeCredential>();
  }

  /** 把当前所有可见 account 列出来；带 `selected` 标记。 */
  async accounts(): Promise<TraeAccountChoice[]> {
    const credentials = await this.readAll();
    const selectedExists = this.accountId !== undefined
      && credentials.some((c) => traeAccountId(c) === this.accountId);
    const defaultSelected = credentials[0];
    return credentials.map((credential) => ({
      id: traeAccountId(credential),
      accountName: credential.accountName ?? (credential.userId || `${credential.edition} account`),
      edition: credential.edition,
      region: regionOfCredential(credential),
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      selected: selectedExists ? traeAccountId(credential) === this.accountId : credential === defaultSelected,
    }));
  }

  /**
   * 当前选中 account。保存的 account 消失时（Trae 重新登录）抛 undefined 而
   * 不是 fallback 到别的 account——避免静默给用户换账号计费。
   */
  async current(): Promise<TraeCredential | undefined> {
    const credentials = await this.readAll();
    if (this.accountId === undefined) return credentials[0];
    return credentials.find((c) => traeAccountId(c) === this.accountId);
  }

  /**
   * 解析出可用凭据：access token 未到期直接返回；剩不到 refreshMarginMs
   * 时触发 refresh，单飞（并发 resolve 只调一次 refreshNow）。
   */
  async resolve(signal?: AbortSignal): Promise<TraeCredential> {
    signal?.throwIfAborted();
    const credential = await this.current();
    signal?.throwIfAborted();
    if (credential === undefined) {
      throw new Error(
        `trae: no signed-in account found (${this.candidates().map((c) => c.path).join(' or ')})`,
      );
    }
    if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential;
    const generation = this.generation;
    return this.refreshWork.run(ownedSignal => this.refreshNow(credential, generation, ownedSignal), signal).catch(error => {
      if (signal?.aborted) throw new Error('Credential refresh cancelled');
      throw error;
    });
  }

  /**
   * 探测登录态——UI / 状态展示用，永不抛错。
   */
  async status(): Promise<
    { state: 'signed-in' | 'signed-out'; edition?: TraeEdition; expiresAtMs?: number; source?: TraeCredential['source'] }
  > {
    try {
      const credential = await this.current();
      return credential === undefined
        ? { state: 'signed-out' }
        : { state: 'signed-in', edition: credential.edition, expiresAtMs: credential.expiresAtMs, source: credential.source };
    } catch {
      return { state: 'signed-out' };
    }
  }

  /** 候选中是否有任一 desktop file 存在——probe 的快速探测。 */
  async desktopFilePresent(): Promise<boolean> {
    for (const candidate of this.candidates()) {
      if (this.fs.existsSync(candidate.path)) return true;
    }
    return false;
  }

  /**
   * 登出：清掉本 store 名下所有 own copy（含 lock sibling），不动 desktop。
   * 区域 store 的 logout 也会清 legacy migration 源——`logout` 是用户"忘掉
   * plugin 自存内容"的动作，不是 per-account toggle。
   */
  dispose(): void {
    this.generation++;
    this.refreshWork.cancel();
    this.refreshWork = new SharedWork<TraeCredential>();
  }

  async logout(): Promise<void> {
    this.dispose();
    for (const path of this.ownCandidates()) {
      this.fs.rmSync(path, { force: true });
      this.fs.rmSync(`${path}.lock`, { force: true });
    }
  }

  /**
   * 诊断：把每个候选文件的失败原因列出（缺 / 不可读 / 解构失败），
   * 让登录失败面板告诉用户具体为什么没拿到 token。
   */
  async diagnose(): Promise<{ tried: readonly TraeStorageCandidate[]; failures: TraeCandidateFailure[] }> {
    const tried = this.candidates();
    const failures: TraeCandidateFailure[] = [];
    for (const candidate of tried) {
      let text: string;
      try {
        text = this.fs.readFileSync(candidate.path);
      } catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : 'unreadable',
          ...(code === 'ENOENT' ? {} : { message: 'Trae credential file could not be read' }),
        });
        continue;
      }
      try {
        this.credentialFrom(candidate, text);
      } catch (error: unknown) {
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: 'invalid',
          message: 'Trae credential file could not be read or decoded',
        });
      }
    }
    return { tried, failures };
  }

  /** 把一个 candidate 的文件内容解出凭据；抛错表示不可用。 */
  private credentialFrom(candidate: TraeStorageCandidate, text: string): TraeCredential {
    let credential: TraeCredential | undefined;
    if (candidate.source === 'cli') {
      // CLI JWT 没有 host claim，用 CN 默认 host 兜底；仅 CN CLI 验证过。
      if (regionOfEdition(candidate.edition) !== 'cn') {
        throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
      }
      const claims = parseTraeCliToken(text);
      credential = normalizeTraeCredential(
        { token: claims.accessToken, userId: claims.userId, host: CLI_DEFAULT_HOST, expiredAt: claims.expiresAtMs },
        candidate.edition,
        'cli',
      );
    } else {
      credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, 'desktop');
    }
    if (credential === undefined) {
      throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
    }
    return credential;
  }

  /** 读所有 desktop candidates；失败项记录到 failures。 */
  private async readDesktopAll(): Promise<{ credentials: TraeCredential[]; failures: TraeCandidateFailure[] }> {
    const credentials: TraeCredential[] = [];
    const failures: TraeCandidateFailure[] = [];
    for (const candidate of this.candidates()) {
      let text: string;
      try {
        text = this.fs.readFileSync(candidate.path);
      } catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : code === undefined ? 'invalid' : 'unreadable',
          ...(code === 'ENOENT' || (code === undefined && !(error instanceof Error)) ? {} : { message: 'Trae credential file could not be read or decoded' }),
        });
        continue;
      }
      try {
        const credential = this.credentialFrom(candidate, text);
        if (!credentials.some((existing) => traeAccountId(existing) === traeAccountId(credential))) {
          credentials.push(credential);
        }
      } catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : code === undefined ? 'invalid' : 'unreadable',
          ...(code === 'ENOENT' || (code === undefined && !(error instanceof Error)) ? {} : { message: 'Trae credential file could not be read or decoded' }),
        });
      }
    }
    return { credentials, failures };
  }

  /** 读所有 own copy；缺文件或损坏跳过。 */
  private async readOwns(): Promise<TraeCredential[]> {
    const copies: TraeCredential[] = [];
    for (const path of this.ownCandidates()) {
      try {
        const parsed = parseOwn(this.fs.readFileSync(path));
        if (parsed !== undefined) copies.push(parsed);
      } catch {
        // absent or unreadable
      }
    }
    return copies;
  }

  /**
   * 双层 account 集合：desktop 自己读的（按 region 过滤）+ plugin own copy
   * （也按 region 过滤，避免 refresh 出来的 token 被另一 region store 拾取）。
   */
  private async readAll(): Promise<TraeCredential[]> {
    const { credentials: desktop } = await this.readDesktopAll();
    const scoped = desktop.filter((c) => this.matchesRegion(c));
    const result: TraeCredential[] = [...scoped];
    for (const own of await this.readOwns()) {
      if (!this.matchesRegion(own)) continue;
      const index = result.findIndex((c) => traeAccountId(c) === traeAccountId(own));
      if (index !== -1) {
        const existing = result[index]!;
        // Unknown identity is not confirmation that two tokens belong to one account.
        if ((own.userId || own.accountName) && own.expiresAtMs > existing.expiresAtMs) result[index] = own;
      } else result.push(own);
    }
    return result;
  }

  /**
   * 主动 refresh 一次；成功后写 own copy；失败时若 access token 还有 > 30s
   * 余量就保留当前 token（graceful），真正过期才抛错让用户重登。
   */
  private async refreshNow(credential: TraeCredential, generation: number, signal?: AbortSignal): Promise<TraeCredential> {
    if (
      credential.refreshToken === undefined
      || (credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= Date.now())
    ) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential;
      throw new Error('trae: access token expired and no valid refresh token is available; sign in again in Trae');
    }
    try {
      const outcome = await this.refresh(credential, signal);
      signal?.throwIfAborted();
      if (this.generation !== generation) throw new Error('Credential refresh was reset');
      const refreshed: TraeCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresAtMs,
        ...(outcome.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs }),
        ...(outcome.host === undefined ? {} : { host: outcome.host }),
        source: 'accessmux',
      };
      const ownPath = this.ownAuthPath();
      if (this.fs !== defaultFs) this.fs.mkdirSync(dirname(ownPath), { recursive: true });
      this.fs.writeFileSync(ownPath, JSON.stringify({ version: TRAE_AUTH_OWN_VERSION, credential: refreshed }));
      return refreshed;
    } catch (error: unknown) {
      if (this.generation !== generation) throw new Error('Credential refresh was reset');
      if (signal?.aborted) throw new Error('Credential refresh cancelled');
      if (credential.expiresAtMs > Date.now() + 30_000) return credential;
      throw new Error(
        `trae: token refresh failed and access token is expired (${safeCredentialError(error, credential)}); sign in again in Trae`,
      );
    }
  }
}
/** Redact exact current secrets before generic text rules (including short tokens). */
export function safeCredentialError(text: unknown, credential: Partial<TraeCredential>): string {
  let out = String(text instanceof Error ? text.message : text);
  const secrets = [credential.accessToken, credential.refreshToken].filter((s): s is string => typeof s === 'string' && s !== '').sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  return redactLogText(out);
}
