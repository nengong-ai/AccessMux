/**
 * AccessMux 模型目录：从本地守护的 `GET /v1/models` 拉取清单，并把每行
 * `<adapterId>:<modelId>` 翻译成 pi-ai 模型描述符所需的全部元数据。
 *
 * 桥接思考控制只消费目录的 bridgeReasoning。上下文窗口、输出上限与
 * 模态仍由 {@link modelMeta} 按来源保守声明，取值与 T006 配置直连时期
 * DSH 里验证过的一组声明一致。补齐值是保守下限：声明小了只会限制用法，
 * 声明大了会在上游真实截断处炸出难以理解的错误。
 *
 * 本模块不 import 任何宿主包，全部纯函数，离线可测。
 *
 * @module dsh-accessmux-connect/catalog
 */

/** 本插件在宿主 LLM seam 里注册的 provider id（含冒号的全模型 id 挂在这一组下）。 */
export const ACCESSMUX_PROVIDER_ID = 'accessmux'

/** AccessMux 模型 id 的分隔符：`<adapterId>:<modelId>`。 */
export const MODEL_ID_SEPARATOR = ':'

/** 各来源在模型选择器里的显示名。 @type {Record<string, string>} */
export const ADAPTER_DISPLAY_NAMES = {
  workbuddy: 'WorkBuddy',
  'trae-cn': 'Trae CN',
  'trae-global': 'Trae Global',
}

/** 守护不可达时目录刷新的重试提示（进宿主日志，不进 UI）。 */
const FETCH_TIMEOUT_MS = 5_000

/**
 * 一行目录模型在插件内的完整描述。
 *
 * @typedef {object} AccessMuxModelInfo
 * @property {string} id 守护侧全格式 id（`workbuddy:hy4-preview`），即 wire `model` 字段。
 * @property {string} adapterId 冒号前的来源段（`workbuddy` / `trae-cn` / `trae-global`）。
 * @property {string} shortId 冒号后的模型段，仅在显示名里出现。
 * @property {string} name 选择器显示名（优先守护公开显示名）。
 * @property {import('@earendil-works/pi-ai').ThinkingLevelMap} [thinkingLevelMap] 已验证桥接档位；未支持键显式 null。
 */

/**
 * 校验并翻译守护的 /v1/models 响应体。
 *
 * 装不上形状的行被跳过而不是让整次刷新失败：一个上游新增的怪异 id
 * 不该拖垮其余 26 个可用模型。没有任何合法行时返回空数组——空目录
 * 在 DSH 里的语义是"整组隐藏"（宿主过滤无模型的组），这正好是我们
 * 想要的守护不可达时的表现。
 *
 * @param {unknown} payload 已 JSON 解析的响应体。
 * @returns {AccessMuxModelInfo[]}
 */
export function parseModelsResponse(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  const data = /** @type {{data?: unknown}} */ (payload).data
  if (!Array.isArray(data)) return []
  const models = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = /** @type {{id?: unknown, name?: unknown, display_name?: unknown}} */ (entry).id
    if (typeof id !== 'string') continue
    const info = modelInfoOf(id)
    if (info !== undefined) {
      const suppliedName = /** @type {{name?: unknown, display_name?: unknown}} */ (entry).display_name ?? /** @type {{name?: unknown}} */ (entry).name
      const name = typeof suppliedName === 'string' ? suppliedName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180) : ''
      const thinkingLevelMap = parseBridgeReasoning(/** @type {{bridgeReasoning?: unknown}} */ (entry).bridgeReasoning)
      models.push({ ...info, ...(name ? { name } : {}), ...(thinkingLevelMap ? { thinkingLevelMap } : {}) })
    }
  }
  return models
}

/** pi-ai 0.87.1 / dsh-llm-pi-ai 0.2.0-rc.2 的公共词表。 */
export const THINKING_LEVELS = /** @type {const} */ (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * 只消费 daemon 的有效桥接控制，不从上游 reasoning 推断。
 * 未提供/未知/无效集合不扩成默认全档；所有未支持键显式 null，防 SDK 补档。
 * @param {unknown} value
 * @returns {import('@earendil-works/pi-ai').ThinkingLevelMap | undefined}
 */
export function parseBridgeReasoning(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const capability = /** @type {{supported?: unknown, supportedEfforts?: unknown, canDisableThinking?: unknown}} */ (value)
  if (capability.supported !== true || !Array.isArray(capability.supportedEfforts)) return undefined
  const efforts = capability.supportedEfforts
  const supported = THINKING_LEVELS.filter(level => efforts.includes(level) &&
    (level !== 'off' || capability.canDisableThinking === true))
  if (supported.length === 0) return undefined
  return Object.fromEntries(THINKING_LEVELS.map(level => [level, supported.includes(level) ? level : null]))
}

/**
 * 一个全格式 id 的目录行，id 不含分隔符或来源段为空时返回 undefined。
 *
 * @param {string} id
 * @returns {AccessMuxModelInfo | undefined}
 */
export function modelInfoOf(id) {
  const at = id.indexOf(MODEL_ID_SEPARATOR)
  if (at <= 0 || at === id.length - 1) return undefined
  const adapterId = id.slice(0, at)
  const shortId = id.slice(at + 1)
  const display = ADAPTER_DISPLAY_NAMES[adapterId] ?? adapterId
  return { id, adapterId, shortId, name: `${display} · ${shortId}` }
}

/**
 * 一个模型的保守元数据声明（上下文窗口 / 输出上限 / 模态）。
 *
 * workbuddy 的取值来自 T006 配置直连时期在 DSH 里真跑过的一组声明；
 * trae 两区同值（Trae 会话上下文上限 200K 量级）。全部 text-only：
 * MVP 阶段插件不接宿主附件服务，声明 image 会让贴图请求撞
 * UNSUPPORTED_CONTENT，声明 text 让宿主直接不给贴图入口，后者诚实。
 *
 * @param {string} id 全格式模型 id。
 * @returns {{contextWindow: number, maxTokens: number, input: Array<'text'>}}
 */
export function modelMeta(id) {
  const info = modelInfoOf(id)
  const adapterId = info?.adapterId ?? ''
  if (adapterId === 'workbuddy') {
    return { contextWindow: 1_000_000, maxTokens: 64_000, input: ['text'] }
  }
  return { contextWindow: 200_000, maxTokens: 32_000, input: ['text'] }
}

/**
 * 拉取一次模型目录。
 *
 * @param {string} baseURL AccessMux OpenAI 兼容端点（形如 `http://127.0.0.1:8080/v1`）。
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<AccessMuxModelInfo[]>} 失败（网络/非 200/坏 JSON）抛错，由调用方决定降级。
 */
export async function fetchModels(baseURL, options = {}) {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const response = await doFetch(new URL('models', ensureTrailingSlash(baseURL)), {
    method: 'GET',
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`dsh-accessmux-connect: /v1/models responded ${response.status}`)
  }
  return parseModelsResponse(await response.json())
}

/** @param {string} url */
function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * 活目录：保存最近一次成功拉取的清单，守护不可达时继续供旧清单
 * （降级服务，与 dsh-workbuddy-connect 的 saved→fallback 次序同思路，
 * 只是没有编译期兜底名册——一个空目录比一份过期名册诚实）。
 *
 * 刷新是单飞的：并发调用共用同一在途请求，撞不出请求风暴。
 */
export class AccessMuxCatalog {
  /** @param {{baseURL: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options */
  constructor(options) {
    this.baseURL = options.baseURL
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs
    /** @type {AccessMuxModelInfo[]} */
    this.models = []
    /** @type {Date | undefined} */
    this.fetchedAt = undefined
    /** @type {string | undefined} */
    this.lastError = undefined
    /** @type {Promise<boolean> | undefined} */
    this.inflight = undefined
  }

  /** @returns {AccessMuxModelInfo[]} */
  current() {
    return this.models
  }

  /**
   * 拉一次目录；清单相对上次发生变化时返回 true（调用方借此决定
   * 是否 invalidate）。失败保留旧清单并记录 lastError，返回 false。
   *
   * @returns {Promise<boolean>}
   */
  refresh() {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = (async () => {
      try {
        const models = await fetchModels(this.baseURL, {
          ...this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl },
          ...this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs },
        })
        this.lastError = undefined
        this.fetchedAt = new Date()
        if (sameRoster(this.models, models)) return false
        this.models = models
        return true
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        return false
      } finally {
        this.inflight = undefined
      }
    })()
    return this.inflight
  }
}

/** @param {AccessMuxModelInfo[]} a @param {AccessMuxModelInfo[]} b */
function sameRoster(a, b) {
  return a.length === b.length && a.every((info, index) => info.id === b[index].id && info.name === b[index].name &&
    THINKING_LEVELS.every(level => info.thinkingLevelMap?.[level] === b[index].thinkingLevelMap?.[level]))
}
