// T033：目录元数据只透传已给出的字段。全部 fake / 内存快照，不联网、不 spawn。
import { describe, expect, it, vi } from 'vitest';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy/index.js';
import { WorkBuddyCatalog } from '../src/adapters/workbuddy/catalog.js';
import { parseWorkBuddyCatalogResponse } from '../src/adapters/workbuddy/parse-catalog.js';
import type { WorkBuddyCredentialStore } from '../src/adapters/workbuddy/credential-store.js';
import { TraeAdapter } from '../src/adapters/trae/index.js';
import { TraeCatalog, FALLBACK_TRAE_MODELS_CN, type TraeModelInfo } from '../src/adapters/trae/catalog.js';
import type { TraeCredentialStore } from '../src/adapters/trae/credential-store.js';
import { freeModelsFromDirectory, type OpencodeModelEntry } from '../src/adapters/opencode/catalog.js';
import { modelInfosFor, startPlanModelInfos } from '../src/adapters/zcode/catalog.js';
import { entitledModelsFromCapabilities } from '../src/adapters/zcode/quota.js';
import { modelsFromIds } from '../src/adapters/qoder/catalog.js';

function workBuddyPayload(extra: Record<string, unknown> = {}) {
  return {
    code: 0,
    data: {
      models: [{ id: 'real-id', name: '公开模型名', maxInputTokens: 200000, maxOutputTokens: 32000, ...extra }],
      agents: [{ name: 'cli', models: ['real-id'] }],
    },
  };
}

async function workBuddyProbe(extra: Record<string, unknown>) {
  const store = {
    status: vi.fn(async () => ({ state: 'signed-in' })),
    dispose: vi.fn(),
  } as unknown as WorkBuddyCredentialStore;
  const adapter = new WorkBuddyAdapter({ credentialStore: store });
  adapter.getCatalog().set(parseWorkBuddyCatalogResponse(workBuddyPayload(extra)));
  vi.spyOn(adapter, 'refreshCatalog').mockResolvedValue();
  try {
    return (await adapter.probe()).models[0]!;
  } finally {
    await adapter.dispose();
  }
}

async function traeProbe(models: readonly TraeModelInfo[]) {
  const store = {
    status: vi.fn(async () => ({ state: 'signed-in' })),
    dispose: vi.fn(),
  } as unknown as TraeCredentialStore;
  const adapter = new TraeAdapter('cn', { credentialStore: store });
  // 测试只喂已有 catalog 快照，不扩大生产解析器范围或添加新的读取入口。
  (adapter as unknown as { catalog: TraeCatalog }).catalog.set(models);
  vi.spyOn(adapter, 'refreshCatalog').mockResolvedValue();
  try {
    return (await adapter.probe()).models;
  } finally {
    await adapter.dispose();
  }
}

function opencodeModels(entries: Record<string, OpencodeModelEntry>) {
  return freeModelsFromDirectory({ all: [{ id: 'opencode', models: entries }] });
}

const zeroCost = { input: 0, output: 0, cache: { read: 0, write: 0 } };

describe('T033 WorkBuddy 真实目录字段', () => {
  it('credits x0.00 credits → 真零倍率/免费；描述、模态、推理透传，路由 id 不变', async () => {
    const model = await workBuddyProbe({
      credits: 'x0.00 credits',
      descriptionZh: '中'.repeat(200),
      descriptionEn: 'English must not replace Chinese',
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: true },
    });
    expect(model).toMatchObject({
      id: 'real-id', provider: 'workbuddy', name: '公开模型名',
      priceMultiplier: { value: 0, current: true, source: { kind: 'platform' } }, free: true, priceScope: 'model',
      description: '中'.repeat(180), inputModalities: ['text', 'image'],
      reasoning: { supported: true, supportedEfforts: ['low', 'high', 'max'], canDisableThinking: true },
    });
    expect(model.activityLabels).toBeUndefined();
  });

  it('非零 credits 不因为活动标签而变免费；标签去色值但不改文案', async () => {
    const model = await workBuddyProbe({
      credits: 'x0.29',
      tags: ['badge:夜间免费:#123456', 'badge:夜间免费:#654321', 'badge: 限时优惠 :#ffffff', 'reasoning'],
    });
    expect(model.priceMultiplier).toMatchObject({ value: 0.29, current: true });
    expect(model.free).toBe(false);
    expect(model.activityLabels).toEqual(['夜间免费', ' 限时优惠 ']);
  });

  it.each([undefined, '', 'unknown', 'x-1', 'xInfinity', '0', 0, Number.NaN])(
    'credits 缺失或不符已知格式 %s 时不编价格', (credits) => {
      const [model] = parseWorkBuddyCatalogResponse(workBuddyPayload({ credits }));
      expect(model?.priceMultiplier).toBeUndefined();
      expect(model?.free).toBeUndefined();
    },
  );

  it('不接受猜测的 multiplier/description aliases；英文回退来自 descriptionEn', () => {
    const [unknown] = parseWorkBuddyCatalogResponse(workBuddyPayload({ multiplier: 0, description: '猜测字段' }));
    expect(unknown?.priceMultiplier).toBeUndefined();
    expect(unknown?.description).toBeUndefined();
    const [english] = parseWorkBuddyCatalogResponse(workBuddyPayload({ descriptionZh: '', descriptionEn: '原文英文' }));
    expect(english?.description).toBe('原文英文');
  });

  it('description 截断以字符计数，不拆开代理对；catalog 防御复制活动标签', () => {
    const parsed = parseWorkBuddyCatalogResponse(workBuddyPayload({
      descriptionZh: '𠮷'.repeat(181), tags: ['badge:限时免费:#ff0000'],
    }));
    expect(Array.from(parsed[0]!.description!)).toHaveLength(180);
    const catalog = new WorkBuddyCatalog();
    catalog.set(parsed);
    (parsed[0]!.activityLabels as string[]).push('不应串入');
    expect(catalog.current()[0]?.activityLabels).toEqual(['限时免费']);
  });

  it('静态 fallback 不标价格/免费/活动', () => {
    for (const model of new WorkBuddyCatalog().current()) {
      expect(model.priceMultiplier).toBeUndefined();
      expect(model.free).toBeUndefined();
      expect(model.activityLabels).toBeUndefined();
    }
  });
});

describe('T033 Trae 已有 ModelInfo 构造透传', () => {
  it('保留已有折后倍率、上游视觉与推理，同时不改变桥接 text-only tags', async () => {
    const [model] = await traeProbe([{
      id: 'live-trae', name: '上游展示名', creditMultiplier: 0.08, input: ['text'],
      multimodal: true, reasoningSupported: true, reasoning: { supported: ['low', 'high'] },
    }]);
    expect(model).toMatchObject({
      id: 'live-trae', name: '上游展示名', priceMultiplier: 0.08, free: false, priceScope: 'model',
      tags: ['text'], inputModalities: ['text', 'image'],
      reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
    });
    expect(model?.activityLabels).toBeUndefined();
    expect(model?.iconUrl).toBeUndefined();
  });

  it('已有真零倍率可标免费，负数/非有限值留空', async () => {
    const models = await traeProbe([
      { id: 'zero', name: 'Zero', creditMultiplier: 0 },
      { id: 'negative', name: 'Negative', creditMultiplier: -1 },
      { id: 'nan', name: 'NaN', creditMultiplier: Number.NaN },
      { id: 'infinity', name: 'Infinity', creditMultiplier: Number.POSITIVE_INFINITY },
    ]);
    expect(models[0]).toMatchObject({ priceMultiplier: 0, free: true });
    for (const model of models.slice(1)) {
      expect(model.priceMultiplier).toBeUndefined();
      expect(model.free).toBeUndefined();
    }
  });

  it('fallback 缺元数据不硬填倍率/免费/视觉/推理', async () => {
    for (const model of await traeProbe(FALLBACK_TRAE_MODELS_CN)) {
      expect(model.priceMultiplier).toBeUndefined();
      expect(model.free).toBeUndefined();
      expect(model.inputModalities).toBeUndefined();
      expect(model.reasoning).toBeUndefined();
    }
  });
});

describe('T033 OpenCode 全零 cost', () => {
  it('原过滤全零 → 免费；名称、显式模态与真实 reasoningEffort 值透传', () => {
    const [model] = opencodeModels({
      'mimo-v2.6-flash-free': {
        name: 'MiMo-V2.6-Flash Free', cost: zeroCost,
        capabilities: { reasoning: true, toolcall: true, input: { text: true, image: true } },
        variants: { displayVariant: { reasoningEffort: 'high' }, ignoredAlias: {} },
      },
    });
    expect(model).toMatchObject({
      id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', free: true, priceScope: 'model',
      inputModalities: ['text', 'image'], reasoning: { supported: true, supportedEfforts: ['high'] },
    });
    expect(model?.priceMultiplier).toBeUndefined(); // cost 不是 credits 倍率
    expect(model?.reasoning?.supportedEfforts).not.toContain('displayVariant');
  });

  it('缺 cost/非零 cost/deprecated 继续被原过滤规则排除', () => {
    expect(opencodeModels({
      missing: { name: 'Missing' },
      paid: { cost: { input: 1, output: 0 } },
      cachedPaid: { cost: { ...zeroCost, cache: { read: 0.1, write: 0 } } },
      retired: { cost: zeroCost, status: 'deprecated' },
    })).toEqual([]);
  });

  it('上游能力和名称缺失不自行补模型描述、视觉或推理档位', () => {
    const [model] = opencodeModels({ bare: { cost: zeroCost } });
    expect(model?.free).toBe(true);
    expect(model?.name).toBeUndefined();
    expect(model?.inputModalities).toBeUndefined();
    expect(model?.reasoning).toBeUndefined();
    expect(model?.description).toBeUndefined();
    expect(model?.activityLabels).toBeUndefined();
  });
});

describe('T033 ZCode 权益范围与 Qoder 未知', () => {
  it('balance 明确模型门覆盖才标权益内免费，不标模型零倍率', () => {
    const entitled = entitledModelsFromCapabilities([{ capabilities: ['model:glm-5.3-flash'] }]);
    expect(entitled).toEqual(['GLM-5.3-Flash']);
    const [model] = modelInfosFor(entitled!);
    expect(model).toMatchObject({ id: 'GLM-5.3-Flash', free: true, priceScope: 'entitlement' });
    expect(model?.priceMultiplier).toBeUndefined();
  });

  it('ZCode 静态 fallback 不硬标免费或推理档位', () => {
    for (const model of startPlanModelInfos()) {
      expect(model.free).toBeUndefined();
      expect(model.priceScope).toBeUndefined();
      expect(model.reasoning).toBeUndefined();
    }
  });

  it('Qoder --list-models 仅 id 不补倍率、免费、描述；保留 unverified 规则', () => {
    const models = modelsFromIds(['Qwen3.8-Flash', 'Qwen3.7-Flash', 'Other']);
    for (const model of models) {
      expect(model.priceMultiplier).toBeUndefined();
      expect(model.free).toBeUndefined();
      expect(model.description).toBeUndefined();
      expect(model.activityLabels).toBeUndefined();
    }
    expect(models[0]?.tags).not.toContain('unverified');
    expect(models[2]?.tags).toContain('unverified');
  });
});
