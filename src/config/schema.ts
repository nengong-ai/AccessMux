// AccessMux 配置 schema：源 → 输出 → 模型 三块。
// 校验用 zod（与 D2 一致），持久化用 YAML（D2）。
// 硬约束：凭据本体不出 shim；本文件不存任何凭据字段。

import { z } from 'zod';

/** 输出设置：D6 MVP 仅 OpenAI 兼容；Anthropic 留勾选占位 */
export const outputSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8080),
  host: z.literal('127.0.0.1').default('127.0.0.1'),
  protocol: z
    .enum(['openai'])
    .default('openai'),
  exposeAnthropic: z.boolean().default(false),
});

/** 单 adapter 配置 */
export const adapterEntrySchema = z.object({
  enabled: z.boolean().default(true),
});

/** 单 adapter 下某模型的 allowlist 启用 */
export const modelAllowSchema = z.boolean();

/** 模型接入：按 adapter 分组的 allowlist（adapter id → modelId → enabled） */
export const modelsSchema = z.object({
  allow: z
    .record(z.string(), z.record(z.string(), modelAllowSchema))
    .default({}),
});

/**
 * checkin（自动签到，T027）：每源开关 + Qoder PAT。
 * - sources：缺省 = 全开（CLI 层 `?? true`）；显式 false 才跳过该源。
 * - qoder.pat：兼容手写配置的**兜底**入口；推荐用
 *   `accessmux checkin --set-pat` 写入 `~/.accessmux/qoder.pat`（0600）——
 *   PAT 不进 /api/state 响应，也不会被 Web UI 保存重建时丢弃
 *   （见 src/checkin/pat-store.ts 注释）。
 * 两字段都保持 optional：老配置文件无需迁移即可通过校验。
 */
export const checkinSourceSchema = z
  .object({
    workbuddy: z.boolean().optional(),
    qoder: z.boolean().optional(),
    zcode: z.boolean().optional(),
  })
  .strict();

export const checkinSchema = z
  .object({
    sources: checkinSourceSchema.optional(),
  })
  .strict();

export const qoderCheckinSchema = z
  .object({
    /** 个人访问令牌（qoder.com.cn 账号设置生成）。原值约束：不入日志/回执。 */
    pat: z.string().optional(),
  })
  .strict();

/** 顶层配置：输出 + adapters + models + checkin + qoder */
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    output: outputSchema,
    adapters: z.record(z.string(), adapterEntrySchema).default({}),
    models: modelsSchema.default({ allow: {} }),
    checkin: checkinSchema.optional(),
    qoder: qoderCheckinSchema.optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type OutputConfig = z.infer<typeof outputSchema>;
export type AdapterEntry = z.infer<typeof adapterEntrySchema>;
export type CheckinConfig = z.infer<typeof checkinSchema>;
export type CheckinSourceSwitches = z.infer<typeof checkinSourceSchema>;

/** 把 zod 校验失败翻译成 UI/CLI 可读的错误 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    })
    .join('；');
}