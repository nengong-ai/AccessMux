// Remote + Wire 两个目录源 join（端口 spec §4.3 + draft mergeTraeModelSources）。
//
// - Remote (solo.trae.cn / coresg.trae.ai 的 /models)：骨架，决定 display
//   name / contextWindow / multimodal / reasoningSupported / 兜底 creditMultiplier
// - Wire (get_detail_param 的 config_name)：决定真 wire id + post-discount
//   creditMultiplier + 列出该 model 的 directory function（chat 时回放）
//
// Join：wire.id == remote.id（大多数情况）；fallback wire.name == remote.name。
// 无 wire match 的 remote model 视为不可调用，从 catalog 移除。

export type TraeInputModality = 'text' | 'image';
import type { MetadataSource, ModelActivity, PriceMultiplier, TokenLimit } from '../../types.js';

export interface TraeCatalogMetadata {
  contextSource?: MetadataSource;
  maxInput?: TokenLimit;
  officialContext?: TokenLimit;
  priceSnapshot?: PriceMultiplier;
  free?: boolean;
  freeSource?: MetadataSource;
  freeActivity?: ModelActivity;
  activityLabels?: string[];
}

export interface TraeDiscoveredModel extends TraeCatalogMetadata {
  id: string;
  name: string;
  contextWindow?: number;
  maxContextWindow?: number;
  creditMultiplier?: number;
  multimodal?: boolean;
  reasoningSupported?: boolean;
  reasoning?: { supported: readonly string[] };
}

export interface TraeWireModel extends TraeCatalogMetadata {
  id: string;
  name: string;
  contextWindow?: number;
  creditMultiplier?: number;
  function?: string;
}

function displayKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface MergedTraeModel extends TraeCatalogMetadata {
  id: string;
  name: string;
  contextWindow?: number;
  maxContextWindow?: number;
  creditMultiplier?: number;
  multimodal?: boolean;
  reasoningSupported?: boolean;
  reasoning?: { supported: readonly string[] };
  input: TraeInputModality[];
  /** llm_utils_chat 真接受的 wire id；undefined 表示 id 本身就是。 */
  wireConfigName?: string;
  /** chat 时回放的 directory function。 */
  wireFunction?: string;
}

/**
 * 合并两个 source。creditMultiplier 优先取 wire 的 `display_contact_config`
 * （即 IDE 渲染的 post-discount 数字）→ fallback 到 remote 的 consumption_rate。
 */
export function mergeTraeModelSources(
  remote: readonly TraeDiscoveredModel[],
  wire: readonly TraeWireModel[],
): MergedTraeModel[] {
  const wireByName = new Map<string, TraeWireModel>();
  const wireById = new Map<string, TraeWireModel>();
  for (const model of wire) {
    wireByName.set(displayKey(model.name), model);
    wireById.set(displayKey(model.id), model);
  }
  const result: MergedTraeModel[] = [];
  for (const model of remote) {
    const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name));
    if (wireModel === undefined) continue;
    const creditMultiplier = wireModel.creditMultiplier ?? model.creditMultiplier;
    const priceSnapshot = wireModel.creditMultiplier === undefined ? model.priceSnapshot : wireModel.priceSnapshot;
    const freeSource = wireModel.creditMultiplier === undefined ? model.freeSource : wireModel.freeSource ?? wireModel.priceSnapshot?.source;
    const freeActivity = wireModel.creditMultiplier === undefined ? model.freeActivity : wireModel.freeActivity;
    result.push({
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow }),
      ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
      ...(priceSnapshot ? { priceSnapshot } : {}),
      ...(model.contextSource ? { contextSource: model.contextSource } : {}),
      ...(wireModel.maxInput ?? model.maxInput ? { maxInput: wireModel.maxInput ?? model.maxInput } : {}),
      ...(model.officialContext ? { officialContext: model.officialContext } : {}),
      ...(freeSource ? { freeSource } : {}),
      ...(freeActivity ? { freeActivity } : {}),
      ...(creditMultiplier !== undefined ? { free: creditMultiplier === 0 } : (wireModel.free ?? model.free) !== undefined ? { free: wireModel.free ?? model.free } : {}),
      ...(wireModel.activityLabels?.length || model.activityLabels?.length ? { activityLabels: [...new Set([...(model.activityLabels ?? []), ...(wireModel.activityLabels ?? [])])] } : {}),
      input: ['text'],
      ...(model.multimodal === undefined ? {} : { multimodal: model.multimodal }),
      ...(model.reasoningSupported === undefined ? {} : { reasoningSupported: model.reasoningSupported }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(wireModel.id !== '' && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {}),
      ...(wireModel.function === undefined ? {} : { wireFunction: wireModel.function }),
    });
  }
  return result;
}
