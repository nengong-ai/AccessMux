/**
 * AccessMux 的 pi-ai provider：一个把请求直接发到本地守护
 * （`http://127.0.0.1:<port>/v1`，OpenAI chat completions）的
 * `PiAiAdapter` 路由，按 dsh-workbuddy-connect 的 adapter 骨架组装。
 *
 * 与 workbuddy 路由的两处结构差异，都是简化：
 *
 * 1. **没有 loopback shim。** AccessMux 自身就是 loopback 守护，且 MVP
 *    不校验 key；workbuddy 需要 shim 是因为要把 pi-ai 看不到的桌面
 *    OAuth token 挡在进程内。这里唯一要注入的是一个非空占位 key，
 *    在 {@link INERT_AUTH} 置空 ambient 通道后由 resolveApiKey 直给。
 * 2. **没有凭据 store / 目录 store。** 模型清单每 60s 从守护拉一次
 *    （见 catalog.js），凭据没有——这正是插件路线绕开 MISSING_CREDENTIAL
 *    凭据墙的机制：pi-ai 的 ambient 凭据发现全程回答"nothing stored,
 *    nothing set"，声明式 provider 那条 `apiKeyEnv` 校验路径从不参与。
 *
 * @module dsh-accessmux-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { modelMeta } from './catalog.js'

/** Provider 流式读期间的空闲上限（与 workbuddy 路由同值）。 */
export const ACCESSMUX_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 惰性的 pi-ai 认证平面：ambient 凭据通道全部回答"nothing stored,
 * nothing set"。没有它，pi-ai 的凭据生命周期可能为一个无 key 的
 * provider 自造凭据或报 MISSING_CREDENTIAL——T006 配置直连撞的就是
 * 这面墙的变体。本插件的唯一"凭据"是 {@link createAccessmuxAdapter}
 * 里注入的静态占位 key，AccessMux 不校验它。
 *
 * 形状照抄 dsh-workbuddy-connect `src/adapter.ts:47-60`（宿主 0.2.0
 * 契约下 `PiAiAdapterOptions.auth` 必填）。
 */
export const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-accessmux-connect: the accessmux route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** 无按量计费可报，全部报零（订阅额度）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** pi-ai 描述符要求但目录不提供的图片请求预算（0.1.1-rc.2 起必填）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** 依赖注入面（测试可替身）。 @typedef {{catalog: import('./catalog.js').AccessMuxCatalog, apiKey?: () => string, retryPolicy?: import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile['retryPolicy'], awaitFirstRefresh?: () => Promise<unknown>}} AccessMuxAdapterOptions */

/**
 * 首刷落定前挂起目录消费的 PiAiAdapter（T025）。
 *
 * headless 启动期解析默认模型时，首次目录刷新可能仍在途，此时目录
 * 还是空的，模型解析会撞 UNKNOWN_MODEL——GUI 无感只是因为启动够慢
 * （T023 实证）。修复取"刷新完成前对目录请求挂起"：{@link LlmAdapter}
 * 上四个读目录的异步入口先等首刷落定，再委托原实现。"落定"指成功或
 * 失败都放行：成功 → 目录已就绪；失败 → 空目录，消费方拿到与守护
 * 不可达时一致的诚实错误，而不是竞态期的假空目录。门只在首刷落定前
 * 存在（daemon 在本机时毫秒级），GUI 的首次消费远晚于此，现行为不变。
 */
class FirstRefreshGatedAdapter extends PiAiAdapter {
  /**
   * @param {import('@deepseek-ai/dsh-llm-pi-ai').PiAiAdapterOptions} config
   * @param {() => Promise<unknown>} awaitFirstRefresh
   */
  constructor(config, awaitFirstRefresh) {
    super(config)
    this.awaitFirstRefresh = awaitFirstRefresh
  }

  /** 门 promise 拒绝也当放行（刷新链自身的问题不该挡在消费前面）。 */
  async passGate() {
    await this.awaitFirstRefresh().catch(() => undefined)
  }

  /** @param {string} provider */
  async listModels(provider) {
    await this.passGate()
    return super.listModels(provider)
  }

  /** @param {string} provider @param {string} model @param {AbortSignal} [signal] */
  async resolveModel(provider, model, signal) {
    await this.passGate()
    return super.resolveModel(provider, model, signal)
  }

  /** @param {string} provider @param {string} model @param {AbortSignal} [signal] */
  async prepareCall(provider, model, signal) {
    await this.passGate()
    return super.prepareCall(provider, model, signal)
  }

  /** @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options */
  async *stream(options) {
    await this.passGate()
    yield* super.stream(options)
  }
}

/**
 * 组装 adapter。provider 的 `getModels` 活读目录，目录刷新后调用
 * {@link AccessMuxAdapter.invalidate} 让 PiAiAdapter 的快照失效即可，
 * 无需重建注册。
 *
 * @param {AccessMuxAdapterOptions & {baseURL: string, providerId?: string, displayName?: string}} options
 * @returns {{adapter: PiAiAdapter, invalidate: () => void}}
 */
export function createAccessmuxAdapter(options) {
  const providerId = options.providerId ?? 'accessmux'
  const displayName = options.displayName ?? 'AccessMux'
  const apiKeyOf = options.apiKey ?? (() => 'local')
  const awaitFirstRefresh = options.awaitFirstRefresh ?? (() => Promise.resolve())

  const buildModels = () => options.catalog.current().map(info => toPiModel(info, options.baseURL, providerId))

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'AccessMux local key',
        async resolve() {
          const apiKey = apiKeyOf()
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'AccessMux' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // getModels 委托给活读（reuse-catalog 模式，同 dsh-workbuddy-connect）：
  // 流式分发仍走构造好的 provider，而目录答案跟着刷新走。
  const provider = { ...base, getModels: () => buildModels() }

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: ACCESSMUX_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: options.retryPolicy ?? resolveRetryPolicy(undefined, 'dsh-accessmux-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  /** PiAiAdapter 以 profiles 对象的同一性识别快照失效。 */
  let profiles = /** @type {Map<string, import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile>} */ (
    new Map([[providerId, /** @type {import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile} */ (profile)]])
  )

  const adapter = new FirstRefreshGatedAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => apiKeyOf(),
  }, awaitFirstRefresh)

  return {
    adapter,
    invalidate: () => {
      profiles = /** @type {Map<string, import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile>} */ (
        new Map([[providerId, /** @type {import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile} */ (profile)]])
      )
    },
  }
}

/**
 * 一个目录行 → 一个 pi-ai 模型描述符。
 *
 * `id` 保留全格式（`workbuddy:hy4-preview`）：pi-ai 的 openai-completions
 * API 把 `model.id` 原样放进 wire `model` 字段，AccessMux 守护靠这个
 * `<adapterId>:<modelId>` 形状路由到对应 bridge。provider 维度已经由
 * `provider` 字段（accessmux）表达，模型 id 不再截短。
 *
 * @param {import('./catalog.js').AccessMuxModelInfo} info
 * @param {string} baseURL 已含 /v1 前缀；SDK 在其后拼 /chat/completions。
 * @param {string} providerId
 * @returns {import('@earendil-works/pi-ai').Model<'openai-completions'>}
 */
function toPiModel(info, baseURL, providerId) {
  const meta = modelMeta(info.id)
  return /** @type {import('@earendil-works/pi-ai').Model<'openai-completions'>} */ ({
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: baseURL,
    input: meta.input,
    // 不声明 reasoning：模型目录不带思考档位信息，缺省即"无思考控制"，
    // wire 上不会出现 reasoning_effort 字段（与 T006 配置直连的声明一致）。
    reasoning: false,
    cost: NO_COST,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  })
}
