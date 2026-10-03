/**
 * AccessMux models for DeepSeek Harness — 把本地 `accessmux serve` 守护
 * 的桥接模型（workbuddy:* / trae-cn:* / trae-global:*）注册成一个
 * "AccessMux" provider 组。零凭据配置：认证在插件内部注入占位值，
 * 从不读环境变量、从不经过 DSH credentials service。
 *
 * 前置条件只有一个：AccessMux 守护在本机跑着（默认
 * `http://127.0.0.1:8080`）。目录每 {@link DEFAULT_POLL_MS} 刷新一次，
 * 守护后启动也能自愈；守护不可达时组保持隐藏（空目录在 DSH 里的
 * 语义就是整组隐藏）。
 *
 * @module dsh-accessmux-connect
 */

import z from '@deepseek-ai/schemastery'
import { AccessMuxCatalog, ACCESSMUX_PROVIDER_ID } from './catalog.js'
import { createAccessmuxAdapter } from './adapter.js'

/** 稳定的 Cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'llm-accessmux'

/** 注册 provider 前必须存在的宿主服务。 */
export const inject = ['llm']

/** AccessMux OpenAI 兼容端点默认值（与 docs/host-integration.md 通用约定一致）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** 占位 key：AccessMux MVP 不校验，但 pi-ai 需要 Bearer 值非空。 */
export const DEFAULT_API_KEY = 'local'

/** 目录刷新间隔默认值。 */
export const DEFAULT_POLL_MS = 60_000

/** 刷新间隔下限：防止错误配置把 sweep 变成请求风暴。 */
const MIN_POLL_MS = 5_000

/** 插件配置（全部带默认值，装完即用；patch 的 `config:` 可覆盖）。 */
export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL)
    .description('AccessMux OpenAI 兼容端点（默认本机 8080）'),
  apiKey: z.string().default(DEFAULT_API_KEY)
    .description('占位 key；AccessMux 不校验，仅需非空。内部注入，不读环境变量'),
  pollMs: z.number().default(DEFAULT_POLL_MS)
    .description('模型目录刷新间隔（毫秒）'),
})

/**
 * 启动：注册 provider、立即拉一次目录、起周期 sweep。
 *
 * 注册无条件发生——目录为空时组只是隐藏，守护起来后的第一次成功
 * 刷新会让它出现，与 dsh-workbuddy-connect 的"注册常在、可见性可变"
 * 同一形态。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{baseURL?: string, apiKey?: string, pollMs?: number}} [config]
 */
export function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const apiKey = config?.apiKey ?? DEFAULT_API_KEY
  const pollMs = clampPollMs(config?.pollMs ?? DEFAULT_POLL_MS)

  const catalog = new AccessMuxCatalog({ baseURL })
  // 首刷落定门（T025）：apply 同步走完后赋值；adapter 的注册在它之后，
  // 消费只能更晚发生，兜底分支只为类型完整。
  /** @type {Promise<boolean> | undefined} */
  let firstRefreshSettled
  const { adapter, invalidate } = createAccessmuxAdapter({
    baseURL,
    catalog,
    apiKey: () => apiKey,
    awaitFirstRefresh: () => firstRefreshSettled ?? Promise.resolve(false),
  })

  const release = ctx.llm.registerAdapter([ACCESSMUX_PROVIDER_ID], adapter)

  let stopped = false

  const refresh = async () => {
    if (stopped) return false
    const changed = await catalog.refresh()
    if (changed) {
      // 换新 profiles 快照并让选择器重读：目录从空到有、或清单增减时走到这里。
      invalidate()
      ctx.emit('llm/adapters-updated')
    }
    return changed
  }

  const timer = setInterval(() => {
    void refresh()
  }, pollMs)
  timer.unref?.()

  try {
    ctx.effect(() => () => {
      stopped = true
      clearInterval(timer)
      release()
    })
  } catch {
    // ctx.effect 在 context 已销毁时抛错：此时它注册的清理器不会跑，
    // 就地释放本插件自己的注册（同 dsh-workbuddy-connect 的处理）。
    stopped = true
    clearInterval(timer)
    release()
  }

  // 首次拉取立即发起，但不再是 fire-and-forget（T025）：adapter 的目录
  // 消费入口会等它落定（成功或失败都放行），headless 启动期解析默认模型
  // 时目录已就绪。失败保持隐藏并在下个 sweep 周期重试，覆盖"先开 DSH
  // 后起 daemon"的顺序；catch 只防 emit 链上的意外拒绝把门挂死。
  firstRefreshSettled = refresh().catch(() => false)
  void firstRefreshSettled.then(() => {
    if (!stopped && catalog.lastError !== undefined) {
      ctx.logger.warn(`dsh-accessmux-connect: AccessMux 目录拉取失败（accessmux serve 未启动？）——${catalog.lastError}；${Math.round(pollMs / 1000)}s 后重试`)
    }
  })
}

/** @param {number} value */
function clampPollMs(value) {
  if (!Number.isFinite(value) || value < MIN_POLL_MS) return MIN_POLL_MS
  return value
}
