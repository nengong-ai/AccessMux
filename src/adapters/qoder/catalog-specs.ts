// 三源目录共享的公开规格表。仅精确 ID/已确认别名匹配，不按模型家族猜数。
// 规格核对日：2026-10-03；只补上下文，不补平台倍率、免费或调用验证态。
import type { MetadataSource, TokenLimit } from '../../types.js';

const checkedAt = '2026-10-03';
const qwen = 'https://help.aliyun.com/zh/model-studio/text-generation-model';
const glm = 'https://docs.bigmodel.cn/cn/guide/start/model-overview';
const deepseek = 'https://api-docs.deepseek.com/api/list-models/';

const specs: Record<string, { value: number; reference: string; field: string }> = {};
function register(ids: string[], value: number, reference: string, field = 'context_window'): void {
  for (const id of ids) specs[id.toLowerCase()] = { value, reference, field };
}
register(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen-3.7-plus', 'qwen3.7-flash', 'qwen3.5-plus'], 1_000_000, qwen);
register(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-official', 'deepseek-v4-pro', 'deepseek-v4-pro-official'], 1_048_576, deepseek);
register(['glm-5.3', 'glm-5.3-flash', 'glm-5.2'], 1_000_000, glm);
register(['glm-5.1', 'glm-5v-turbo'], 200_000, glm);
register(['kimi-k3', 'kimi-k3-1', 'kimi-k2.8-preview'], 1_048_576, 'https://www.kimi.com/code/docs/kimi-code/models.html');
register(['kimi-k2.5'], 262_144, 'https://huggingface.co/moonshotai/Kimi-K2.5/raw/main/config.json', 'text_config.max_position_embeddings');
register(['kimi-k2.6'], 262_144, 'https://huggingface.co/moonshotai/Kimi-K2.6/raw/main/config.json', 'text_config.max_position_embeddings');
register(['kimi-k2.7', 'kimi-k2.7-code'], 262_144, 'https://platform.kimi.ai/docs/models');
register(['minimax-m2.7'], 204_800, 'https://help.aliyun.com/zh/model-studio/minimax-m2-7');
register(['minimax-m3'], 1_000_000, 'https://platform.minimax.io/docs/guides/models-intro');
register(['hy3', 'hy3-x'], 256_000, 'https://cloud.tencent.com/announce/detail/2384');

export function positiveTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function tokenValue(limit: number | TokenLimit | undefined): number | undefined {
  return positiveTokens(typeof limit === 'object' && limit !== null ? limit.value : limit);
}

export function source(reference: string, field: string, updated_at: string, region?: string): MetadataSource {
  return { kind: 'platform', reference, field, updated_at, ...(region === undefined ? {} : { region }) };
}

export function tokenLimit(value: unknown, origin: MetadataSource): TokenLimit | undefined {
  const tokens = positiveTokens(value);
  return tokens === undefined ? undefined : { value: tokens, source: { ...origin } };
}

/** 不剥除未知 provider 前缀；opencode-go 的这两个 Qwen 别名已由目录确认。 */
export function officialModelContext(id: string): TokenLimit | undefined {
  const key = id.toLowerCase();
  const canonical = /^opencode-go\/qwen3\.8-(max|flash)$/.test(key) ? key.slice('opencode-go/'.length) : key;
  const spec = specs[canonical];
  return spec === undefined ? undefined : {
    value: spec.value,
    source: { kind: 'official-spec', reference: spec.reference, field: spec.field, updated_at: checkedAt },
  };
}
