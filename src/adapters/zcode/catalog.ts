// ZCode Start Plan 模型清单（T019）。
// 固定自内置目录 builtinModelIds（R014 §1.1：`config/provider/zcode-builtin.json`
// start-plan 节），不拉远端目录。清单变化随 App 升级，probe 照常上报固定三名。

import type { ModelInfo } from '../../types.js';
import { source } from '../qoder/catalog-specs.js';

/** Start Plan 权益模型（顺序即官方 builtinModelIds 顺序，flash 排第一）。 */
export const START_PLAN_MODELS: readonly string[] = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'];

/**
 * T036 真机实证可收图的模型（直连 image block 往返、答出图中标记）：仅
 * GLM-5.3-Flash 验证过；GLM-5.2 / GLM-5-Turbo 未做图片往返，不盖
 * inputModalities，模型级保持灰标（打通才亮标，不虚标）。
 */
export const VISION_VERIFIED_MODELS: ReadonlySet<string> = new Set(['GLM-5.3-Flash']);

export const START_PLAN_PROVIDER_ID = 'account:bigmodel-start-plan';

/** app-server 形态必填 reasoningLevel；`disabled` 不被支持（R016 §2.3-3）。 */
export const START_PLAN_REASONING_LEVEL = 'low';

export function isStartPlanModel(modelId: string): boolean {
  return START_PLAN_MODELS.includes(modelId);
}

function modelBase(id: string): ModelInfo {
  return {
    id,
    provider: 'zcode',
    tags: ['coding', 'chat'],
    ...(VISION_VERIFIED_MODELS.has(id) ? { inputModalities: ['text', 'image'] as Array<'text' | 'image'> } : {}),
  };
}

export function startPlanModelInfos(): ModelInfo[] {
  return START_PLAN_MODELS.map((id) => modelBase(id));
}

/** 仅供 balance capabilities 已明确覆盖的子集；不表示模型本身零价或无限额度。 */
export function modelInfosFor(ids: readonly string[]): ModelInfo[] {
  const observedAt = new Date().toISOString();
  return ids.map((id) => ({
    ...modelBase(id),
    free: true,
    priceScope: 'entitlement',
    freeSource: source('zcode:balance', 'entitledModels', observedAt, 'cn'),
    feeFreshness: 'fresh',
    feeCheckedAt: observedAt,
  }));
}
