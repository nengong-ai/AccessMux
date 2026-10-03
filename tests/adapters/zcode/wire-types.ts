// T019 测试公桩用的最小类型再导出（避免从实现文件 import 私类型）。

export type { AppServerChild, AppServerPaths } from '../../../src/adapters/zcode/app-server.js';

export interface WireMessageLike {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}
