// `accessmux checkin` 协调器（T027；docs/source-spec-checkin.md §5.1 产品形态）。
//
// 一次性执行所有已配置源的领取，幂等（重复跑安全），输出每源一行结果。
// 退出码由 printCheckinResults 决定：0 = 无 error 级失败（含全已领/活动关闭/
// 跳过）；1 = 出现 error 级失败；CLI 层配置错误另有 2。
//
// 凭据链复用（铁律：不改 adapter，只 import）：
// - workbuddy：WorkBuddyCredentialStore.resolve()（生产 spawn 解密链）
// - zcode：loadZcodeCredential()（读 ~/.zcode/v2/credentials.json）
// - qoder：PAT（官方正门；文件 ~/.accessmux/qoder.pat 优先，config.qoder.pat 兜底），
//   不碰 attach 推理链（D27：checkin 专用旁路）。

import type { CheckinResult } from './types.js';
import { formatCheckinLine } from './types.js';
import { runWorkBuddyCheckin, type WorkBuddyCheckinCredential } from './workbuddy.js';
import { runQoderCheckin } from './qoder.js';
import { runZcodeCheckin, type ZcodeCheckinCredential } from './zcode.js';
import { WorkBuddyCredentialStore } from '../adapters/workbuddy/credential-store.js';
import { createSpawnKeyProvider } from '../adapters/workbuddy/key-provider.js';
import { DEFAULT_WORKBUDDY_VARIANT } from '../adapters/workbuddy/variant.js';
import { loadZcodeCredential } from '../adapters/zcode/credential-store.js';
import { errorText } from './types.js';

export interface CheckinSourceSwitches {
  workbuddy?: boolean;
  qoder?: boolean;
  zcode?: boolean;
}

export interface CheckinOptions {
  /** 每源开关（默认全开）；来自 config.checkin.sources。 */
  sources?: CheckinSourceSwitches;
  /** Qoder PAT（文件读取交由 CLI 层完成，这里只收最终值）。 */
  qoderPat?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** ZCode 凭据 home 覆盖（测试用）。 */
  home?: string;
  log?: (line: string) => void;
  /** 测试钩子：替换 WorkBuddy 凭据解析（默认走生产 credential store）。 */
  resolveWorkBuddyCredential?: () => Promise<WorkBuddyCheckinCredential>;
  /** 测试钩子：替换 ZCode 凭据解析（默认读 ~/.zcode/v2/credentials.json）。 */
  loadZcodeCheckinCredential?: () => ZcodeCheckinCredential;
}

const SOURCE_ORDER = ['workbuddy', 'qoder', 'zcode'] as const;

/** 生产 WorkBuddy 凭据解析：惰性构造 store（不跑就零副作用）。 */
function workBuddyResolver(options: CheckinOptions): () => Promise<WorkBuddyCheckinCredential> {
  if (options.resolveWorkBuddyCredential !== undefined) return options.resolveWorkBuddyCredential;
  let store: WorkBuddyCredentialStore | undefined;
  return async () => {
    store ??= new WorkBuddyCredentialStore({
      variant: DEFAULT_WORKBUDDY_VARIANT,
      keyProvider: createSpawnKeyProvider(DEFAULT_WORKBUDDY_VARIANT),
      refresh: (c) => import('../adapters/workbuddy/refresh.js').then(({ refreshWorkBuddyCredential }) =>
        refreshWorkBuddyCredential(c, options.fetchImpl ?? fetch)),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const credential = await store.resolve();
    return { accessToken: credential.accessToken, userId: credential.userId };
  };
}

function zcodeResolver(options: CheckinOptions): () => ZcodeCheckinCredential {
  if (options.loadZcodeCheckinCredential !== undefined) return options.loadZcodeCheckinCredential;
  return () => {
    const credential = loadZcodeCredential({
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return { jwt: credential.jwt, deviceMid: credential.deviceMid };
  };
}

/** 单源异常兜底：任何逃逸异常都归一为 error 结果（单源隔离原则）。 */
async function guard(source: string, run: () => Promise<CheckinResult>): Promise<CheckinResult> {
  try {
    return await run();
  } catch (error) {
    return { source: source as CheckinResult['source'], verdict: 'error', message: errorText(error) };
  }
}

/**
 * 跑一遍全部源。单源失败不影响其余；返回逐源结果，顺序 =
 * WorkBuddy（T-first）→ Qoder（T-second）→ ZCode（顺带）。
 */
export async function runCheckinAll(options: CheckinOptions = {}): Promise<CheckinResult[]> {
  const sourceOn = (name: (typeof SOURCE_ORDER)[number]): boolean => options.sources?.[name] ?? true;
  const results: CheckinResult[] = [];

  if (sourceOn('workbuddy')) {
    const resolveCredential = workBuddyResolver(options);
    results.push(await guard('workbuddy', () => runWorkBuddyCheckin({
      resolveCredential,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })));
  }

  if (sourceOn('qoder')) {
    results.push(await guard('qoder', () => runQoderCheckin({
      resolvePat: () => options.qoderPat,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })));
  }

  if (sourceOn('zcode')) {
    const loadCredential = zcodeResolver(options);
    results.push(await guard('zcode', () => runZcodeCheckin({
      loadCredential,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })));
  }

  return results;
}

/** 结果行打印 + 退出码（0 无 error；1 有 error）。 */
export function printCheckinResults(
  results: readonly CheckinResult[],
  log: (line: string) => void = console.log,
): number {
  for (const result of results) log(formatCheckinLine(result));
  return results.some((r) => r.verdict === 'error') ? 1 : 0;
}
