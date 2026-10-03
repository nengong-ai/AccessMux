// Trae SoloBridge：display id → wire config_name 翻译 + 推理 effort 翻译
// （端口 spec §3.2.2 + §4.3.3）。
//
// 工作流：
// 1. 读 request body 的 model id（可能是 display id）
// 2. 在 catalog 里找到这一行 → 拿 wireConfigName / wireFunction
// 3. 若有 catalog 没列出的 id，尝试 wireResolver（启动期 seed）回退
// 4. 把 model id 改成 wireConfigName；stale function 改成 wireFunction
// 5. reasoning_effort 翻译（OpenAI 档位 → Trae 档位）
// 6. 调下层 chatStream，把上游 Response 用 sse-bridge 转成 OpenAI 形状

import { prepareSoloBody } from './request-shaper.js';
import { bridgeTraeSoloStream } from './sse-bridge.js';

export interface TraeWireTarget {
  configName: string;
  function?: string;
}

export type TraeWireResolver = (displayId: string) => TraeWireTarget | undefined;

export interface TraeChatInput {
  bodyJson: string;
  signal?: AbortSignal;
}

export interface TraeChatResult {
  ok: boolean;
  status: number;
  kind: 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured';
  message: string;
  response?: Response;
}

/** 下层上游调用：把准备好的 JSON body 发到上游，返回 SSE Response。 */
export type TraeUpstreamCaller = (bodyJson: string, signal?: AbortSignal) => Promise<TraeChatResult>;

export interface BridgeCatalogEntry {
  id: string;
  name?: string;
  wireConfigName?: string;
  wireFunction?: string;
  reasoning?: { supported: readonly string[] };
}

interface BridgeCatalogSource {
  current(): readonly BridgeCatalogEntry[];
}

function resolveEffort(
  mapping: Partial<Record<string, string | null>> | undefined,
  requested: string,
): string | undefined {
  if (mapping === undefined) return undefined;
  const value = mapping[requested as keyof typeof mapping];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 取 display id → wire target 的翻译结果。优先级 catalog entry → wireResolver。
 * 任何一个能解析就用 target；都没有就用原 id（model 即 wire id 的常见）。
 */
function resolveTarget(
  modelId: string,
  catalog: readonly BridgeCatalogEntry[],
  resolver: TraeWireResolver | undefined,
): TraeWireTarget | undefined {
  const entry = catalog.find((m) => m.id === modelId);
  const fromCatalog = entry?.wireConfigName === undefined
    ? undefined
    : { configName: entry.wireConfigName, ...(entry.wireFunction === undefined ? {} : { function: entry.wireFunction }) };
  const fromResolver = resolver?.(modelId) ?? (entry?.name !== undefined ? resolver?.(entry.name) : undefined);
  return fromCatalog ?? fromResolver;
}

/**
 * 包装下层 upstream caller：处理 display → wire 翻译 + SSE bridge。
 * 不改 chatStream 的网络层，只改写请求体 + 流响应转换。
 */
export class TraeSoloBridge {
  constructor(
    private readonly upstream: TraeUpstreamCaller,
    private readonly catalog?: BridgeCatalogSource,
    private readonly wireResolver?: TraeWireResolver,
  ) {}

  async chatStream(input: TraeChatInput): Promise<TraeChatResult> {
    let body: Record<string, unknown>;
    let originalModel = 'unknown';
    try {
      const parsed = JSON.parse(input.bodyJson) as Record<string, unknown>;
      body = parsed;
      originalModel = typeof body['model'] === 'string' ? body['model'] : originalModel;
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' };
    }
    const catalogList = this.catalog?.current() ?? [];
    const target = resolveTarget(originalModel, catalogList, this.wireResolver);
    if (target !== undefined && target.configName !== body['model']) {
      body['model'] = target.configName;
    }
    if (target?.function !== undefined && body['function'] !== target.function) {
      body['function'] = target.function;
    }
    if (body['reasoning_effort'] !== undefined) {
      const entry = catalogList.find((m) => m.id === originalModel);
      const requested = body['reasoning_effort'];
      if (typeof requested !== 'string' || !entry?.reasoning?.supported.includes(requested)) {
        return { ok: false, status: 400, kind: 'client', message: 'Trae model does not advertise requested reasoning effort' };
      }
    }
    let bodyJson = JSON.stringify(body);
    try {
      bodyJson = prepareSoloBody(bodyJson, { functionName: target?.function });
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' };
    }
    const result = await this.upstream(bodyJson, input.signal);
    if (!result.ok) return result;
    if (result.response === undefined) {
      return { ok: false, status: 502, kind: 'server', message: 'upstream returned no response' };
    }
    return { ok: true, status: 200, kind: 'unconfigured', message: '', response: bridgeTraeSoloStream(result.response, originalModel) };
  }
}
