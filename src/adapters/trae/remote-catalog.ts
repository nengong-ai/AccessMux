// SOLO Remote `/models` 拉取（端口 spec §3.2.5 + §4.3.3）。
//
// 这是骨架粒度的目录（display id / name / context / multimodal / reasoning）。
// 与 directory.ts（wire id / post-discount credit）的区别：
// - Remote 决定"是不是这个 model"，但不知道 wire config_name
// - Directory 决定"怎么调它"，但不知道 display name / 上下文
// merge-sources.ts 把两边 join 起来。

import { safeCredentialError } from './credential-store.js';
import type { TraeCredential } from './credential-store.js';
import { REGION_GATEWAYS, regionOfCredential } from './region.js';
import type { TraeDiscoveredModel } from './merge-sources.js';
import { parseTraeRemoteModel } from './remote-parser.js';

export interface TraeRemoteCatalogOptions {
  credential(): Promise<TraeCredential>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * 不同区域走不同 dressing（端口 spec §3.3 + 协议事实）：
 * - CN：referer solo.trae.cn / zh-cn / Asia/Shanghai
 * - AI：referer coresg-normal.trae.ai / en / Asia/Singapore
 */
function remoteDressing(region: 'cn' | 'ai'): { referer: string; timezone: string; language: string } {
  return region === 'ai'
    ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
    : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' };
}

async function buildHeaders(
  credential: TraeCredential,
  region: 'cn' | 'ai',
): Promise<Record<string, string>> {
  const dressing = remoteDressing(region);
  return {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'Content-Type': 'application/json',
    'x-trae-client-type': 'web',
    'x-trae-user-timezone': dressing.timezone,
    'x-preferenced-language': dressing.language,
    'Referer': dressing.referer,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

/**
 * 只读目录客户端：故意只暴露 fetchModels，不暴露 chat/session
 * （Remote session 协议只能返回最终答案，不保留 agent 的结构化工具循环）。
 */
export class TraeRemoteCatalogClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly options: TraeRemoteCatalogOptions;

  constructor(options: TraeRemoteCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.options = options;
  }

  async fetchModels(signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
    const credential = await this.options.credential();
    const region = regionOfCredential(credential);
    const base = this.baseUrl ?? REGION_GATEWAYS[region].remote;
    const headers = await buildHeaders(credential, region);
    try {
    const response = await this.fetchImpl(
      `${base}/models?functions=solo_agent_remote,solo_work_remote`,
      { headers, signal: signal === undefined ? AbortSignal.timeout(this.timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) },
    );
    if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`);
    const json = await response.json() as { data?: { list?: { function?: string; models?: unknown[] }[] } };
    const groups = json.data?.list ?? [];
    const preferred = groups.find((g) => g.function === 'solo_agent_remote') ?? groups[0];
    const seen = new Set<string>();
    const models: TraeDiscoveredModel[] = [];
    for (const raw of preferred?.models ?? []) {
      const model = parseTraeRemoteModel(raw, { region, updatedAt: new Date().toISOString() });
      if (model === undefined || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (models.length === 0) throw new Error('SOLO remote models response contained no models');
    return models;
    } catch (error) { throw new Error(safeCredentialError(error, credential)); }
  }
}
