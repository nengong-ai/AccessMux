// Trae 上游 endpoint path + baseUrl 拼接工具（端口 spec §3.2 + 协议事实）。
//
// CN 与 AI 共用同一份 path 模板；baseUrl 由 region 决定（见 region.ts）。
// ACCESS_MUX 在国内默认走 CN（D9 + internal development record 红线：不默认数据出境）。

import { REGION_GATEWAYS, type TraeRegion } from './region.js';

/** Agent task（`/api/agent/v3/create_agent_task`）— 当前 AccessMux 不使用，预留。 */
export const TRAE_CN_AGENT_TASK_PATH = '/api/agent/v3/create_agent_task';

/** Chat 主路径：`/api/agent/v3/llm_utils_chat`。 */
export const TRAE_CN_TITLE_PATH = '/api/agent/v3/llm_utils_chat';

/** Chat 主路径别名：保持与目录内命名一致（TRAE_SOLO_CHAT_PATH）。 */
export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat';

/** 模型目录 `get_detail_param`：CN 与 AI 共用此路径。 */
export const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param';

/** 把 baseUrl + path 拼成完整 URL，去掉两端多余斜杠。 */
export function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** 给定区域，返回 chat base。 */
export function chatBaseFor(region: TraeRegion): string {
  return REGION_GATEWAYS[region].chat;
}

/** 给定区域，返回 SOLO remote base。 */
export function remoteBaseFor(region: TraeRegion): string {
  return REGION_GATEWAYS[region].remote;
}