// `--list-models` 目录层（T020）。控制面调用（非推理请求），耗时 ~1-2s。
// 诚实标注（验收 #4）：清单混有免费档与权益/付费模型，--list-models 不区分，
// 逐个实证会烧额度——除已实测模型外一律打 'unverified' 标签，不虚标免费。
// 已实证（R018 §2.2 + T020 真机）：Qwen3.8-Flash（qfmodel 默认，billable:false）、
// Qwen3.7-Flash（-m 定向实证）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { abortable } from '../../util/abort.js';
import type { ModelInfo } from '../../types.js';
import { parseListModels } from './protocol.js';
import type { QoderMetadataMap } from './catalog-metadata.js';
import { officialModelContext } from './catalog-specs.js';

const exec = promisify(execFile);

/** 已真机实证可直接消费的模型（免费档实测 billable:false / 定向成功）。 */
export const VERIFIED_MODELS: ReadonlySet<string> = new Set([
  'Qwen3.8-Flash',
  'Qwen3.7-Flash',
]);

/**
 * T036 真机实证可收图的模型（stream-json image block 往返、答出图中标记）：
 * 仅 Qwen3.8-Flash 验证过；其余未做图片往返，不盖 inputModalities（不虚标）。
 */
export const VISION_VERIFIED_MODELS: ReadonlySet<string> = new Set(['Qwen3.8-Flash']);

export interface ListModelsDeps {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** 执行 --list-models（测试注入用）。 */
  execFile?: (file: string, args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  timeoutMs?: number;
}

/** 拉取并解析模型清单；任何失败原样抛（probe 层收敛 unavailable）。 */
export async function fetchModelIds(binary: string, deps: ListModelsDeps = {}): Promise<string[]> {
  deps.signal?.throwIfAborted();
  const run =
    deps.execFile ??
    ((file: string, args: readonly string[]) =>
      exec(file, [...args], { timeout: deps.timeoutMs ?? 30_000, env: deps.env, signal: deps.signal, killSignal: 'SIGKILL' }));
  const { stdout } = await abortable(run(binary, ['--list-models'], ...(deps.signal ? [{ signal: deps.signal }] : [])), deps.signal);
  return parseListModels(stdout);
}

/** 模型 id → ModelInfo（provider 固定 'qoder'；未实证模型带 'unverified' 标签）。 */
export function modelsFromIds(ids: readonly string[], metadata: QoderMetadataMap = {}): ModelInfo[] {
  return ids.map((id) => {
    const { customProvider, ...fields } = metadata[id] ?? {};
    const official = officialModelContext(id);
    return {
    id,
    provider: 'qoder',
    tags: customProvider ? ['chat', 'custom-provider', 'unverified'] : VERIFIED_MODELS.has(id) ? ['chat'] : ['chat', 'unverified'],
    ...fields,
    ...(fields.minCtx ?? official ? { minCtx: fields.minCtx ?? official } : {}),
    ...(official === undefined ? {} : { officialContext: official }),
    callVerified: !customProvider && VERIFIED_MODELS.has(id),
    ...(!customProvider && VISION_VERIFIED_MODELS.has(id) ? { inputModalities: ['text', 'image'] as Array<'text' | 'image'> } : {}),
    };
  });
}
