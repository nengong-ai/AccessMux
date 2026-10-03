// UI 模块：把 /ui 静态资源 + /api/* 配置接口挂载到 Fastify。
// 配置保存即时生效（hot apply）：onChange 通知 protocol 层刷新 allowlist / adapter 启停。

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { readInstalledAppIcon, readInstalledWorkBuddyIcon, type LocalAppIconFamily } from './local-app-icons.js';
import { fileURLToPath } from 'node:url';
import { extname, dirname, join, resolve } from 'node:path';
import { transform } from 'esbuild';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAdapters } from '../adapters/registry.js';
import {
  ConfigStore,
  buildDefaultConfig,
  loadConfigFromPath,
  saveConfigToPath,
} from '../config/index.js';
import {
  createUiServices,
  publicUiConfig,
  safeUiMutation,
  snapshotAdapterInfo,
  UiServiceError,
  type UiServicesOptions,
} from './services.js';

/** 保留 T031 公开投影入口；实际投影对嵌套字段同样采用显式白名单。 */
export const publicConfig = publicUiConfig;

export interface UiMountOptions {
  store: ConfigStore;
  /** 配置文件路径，用于首启检测 + 落盘 */
  configPath: string;
  /** UI 仅模式：不挂 LLM 端点（用于 `accessmux ui` 子命令） */
  uiOnly?: boolean;
  controlTimeoutMs?: number;
  /** 本地检测/领取/定时器依赖；离线测试不得触及真实 HOME 与凭据。 */
  uiServices?: UiServicesOptions;
  workBuddyIconLoader?: () => Buffer | undefined;
  localAppIconLoader?: (family: LocalAppIconFamily) => Buffer | undefined;
}

/** 定位 UI 静态资源目录（dev: src/ui/public; prod: dist/ui/public） */
export function uiAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'public');
}

const savePayloadSchema = z.object({
  output: z
    .object({
      port: z.number().int().min(1).max(65535),
      exposeAnthropic: z.boolean(),
    })
    .partial()
    .strict()
    .optional(),
  adapters: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()).optional(),
  models: z
    .object({
      allow: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
    })
    .strict()
    .optional(),
  checkin: z.object({
    sources: z.object({
      workbuddy: z.boolean().optional(),
      qoder: z.boolean().optional(),
      zcode: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const checkinPayloadSchema = z.object({ source: z.string() }).strict();
const onboardQuerySchema = z.object({ host: z.string().min(1).max(80) }).strict();

export function mountUiRoutes(app: FastifyInstance, opts: UiMountOptions): void {
  const { store, configPath } = opts;
  const assetsDir = uiAssetsDir();
  const services = createUiServices(store, opts.uiServices);
  const adapters = (forceRefresh = false) => snapshotAdapterInfo(
    listAdapters(), store.get(), opts.uiServices?.adapterTimeoutMs ?? opts.controlTimeoutMs,
    { forceRefresh, env: opts.uiServices?.env },
  );

  // 新领取入口和既有配置写入口都防止跨站页面操纵本机服务。
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || ![
      '/api/config', '/api/config/reset', '/api/config/reset-selection', '/api/checkin', '/api/probe',
    ].includes(req.routeOptions.url ?? '')) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if ((origin !== undefined && typeof origin !== 'string') || (fetchSite !== undefined && typeof fetchSite !== 'string') || !safeUiMutation({
      host: req.headers.host,
      origin: typeof origin === 'string' ? origin : undefined,
      fetchSite: typeof fetchSite === 'string' ? fetchSite : undefined,
    }, req.protocol, req.ip)) return reply.code(403).send({ error: { message: '只允许本机同源请求' } });
  });

  // 有界 timer 属于现有 Fastify 服务；app.close 不留后台自动领取任务。
  app.addHook('onReady', async () => { services.start(); });
  app.addHook('preClose', async () => { services.close(); });

  // T021（T004 挂账清偿）：adapter 启停联动 region 注册原语——启动时按当前
  // 配置同步一次，之后配置每次变更（UI 保存 / reset）经 store.onChange 继续
  // 同步。trae-global 等双 region 源的启停由此真实生效；未实现 setEnabled 的
  // adapter 跳过（duck-typing，不改 ProviderAdapter 接口）。
  const syncAdapterEnabled = (cfg: { adapters: Record<string, { enabled: boolean }> }): void => {
    for (const a of listAdapters()) {
      (a as { setEnabled?: (b: boolean) => void }).setEnabled?.(cfg.adapters[a.id]?.enabled ?? true);
    }
  };
  syncAdapterEnabled(store.get());
  const unsubscribe = store.onChange(syncAdapterEnabled);
  app.addHook('onClose', async () => {
    services.close();
    unsubscribe();
  });

  // 首启检测：返回 config 路径是否存在，UI 用来切换 wizard/config 视图
  app.get('/api/bootstrap', async () => {
    return {
      configExists: existsSync(configPath),
      configPath,
      adapters: await adapters(),
      config: publicConfig(store.get()),
      ...services.hosts(),
      checkin: services.checkin(),
    };
  });

  app.get('/api/state', async () => {
    return {
      config: publicConfig(store.get()),
      adapters: await adapters(),
      ...services.hosts(),
      checkin: services.checkin(),
    };
  });

  app.post('/api/probe', async (req, reply) => {
    if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || Object.keys(req.body as object).length !== 0)) {
      return reply.code(400).send({ error: { message: '刷新请求不接受额外参数' } });
    }
    const snapshots = await adapters(true);
    const directory = snapshots.filter((adapter) => adapter.directoryReady)
      .flatMap((adapter) => adapter.models.map((model) => ({ adapterId: adapter.id, model })));
    const metadataSync = await services.refreshWorkBuddyDisplayNames(directory);
    return { adapters: snapshots, metadataSync };
  });

  app.get('/api/hosts', async () => services.hosts());
  app.get('/api/checkin', async () => services.checkin());
  app.get('/api/onboard', async (req, reply) => {
    const parsed = onboardQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { message: '请选择需要引导的宿主' } });
    try {
      // 指引示例只用已启用模型的公开 id；不执行探针之外的请求或接入动作。
      const modelIds = (await adapters()).flatMap((adapter) => adapter.models
        .filter((model) => store.get().models.allow[adapter.id]?.[model.id] !== false)
        .map((model) => `${adapter.id}:${model.id}`));
      return services.onboardGuide(parsed.data.host, modelIds);
    } catch (error) {
      return reply.code(error instanceof UiServiceError ? error.statusCode : 400).send({
        error: { message: error instanceof UiServiceError ? error.message : '接入引导暂不可用' },
      });
    }
  });
  app.post('/api/checkin', async (req, reply) => {
    const parsed = checkinPayloadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { message: '请选择支持领取的源' } });
    try {
      const result = await services.claim(parsed.data.source);
      return { ok: true, result, checkin: services.checkin() };
    } catch (error) {
      return reply.code(error instanceof UiServiceError ? error.statusCode : 400).send({
        error: { message: error instanceof UiServiceError ? error.message : '领取失败，请稍后重试' },
      });
    }
  });

  app.post('/api/config', async (req, reply) => {
    const parsed = savePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { message: '请求体不合法：只接受公开设置与支持源的签到开关' } });
    }
    const current = store.get();
    const incoming = parsed.data;
    // 浅合并：incoming 是 partial，顶层字段不传 → 保留 current；adapters / models.allow 按 key 浅合并。
    const mergedAdapters = incoming.adapters
      ? { ...current.adapters, ...incoming.adapters }
      : current.adapters;
    const mergedAllow: Record<string, Record<string, boolean>> = {};
    for (const [k, v] of Object.entries(current.models.allow)) {
      mergedAllow[k] = { ...v };
    }
    if (incoming.models?.allow) {
      for (const [adapterId, models] of Object.entries(incoming.models.allow)) {
        mergedAllow[adapterId] = { ...(mergedAllow[adapterId] ?? {}), ...models };
      }
    }
    try {
      const cfg = {
        ...current,
        version: 1 as const,
        output: { ...current.output, ...(incoming.output ?? {}) },
        adapters: mergedAdapters,
        models: { ...current.models, allow: mergedAllow },
        ...(incoming.checkin === undefined ? {} : {
          checkin: {
            ...current.checkin,
            sources: { ...current.checkin?.sources, ...incoming.checkin.sources },
          },
        }),
      };
      // 落盘后再 set，保证磁盘 = 内存。
      saveConfigToPath(configPath, cfg);
      store.set(cfg);
      return { ok: true, config: publicConfig(store.get()) };
    } catch {
      return reply
        .code(400)
        .send({ error: { message: '配置未能保存，请检查本机配置文件和写入权限' } });
    }
  });

  app.post('/api/config/reset', async (_req, reply) => {
    const cfg = buildDefaultConfig();
    try {
      saveConfigToPath(configPath, cfg);
      store.set(cfg);
      // reset 明确清除完整主配置（含兼容 PAT / checkin），不触碰独立 PAT 文件。
      return { ok: true, config: publicConfig(cfg) };
    } catch {
      return reply.code(400).send({ error: { message: '配置未能重置，请检查本机配置文件和写入权限' } });
    }
  });

  // T033 只重置源/模型选择；保留端口、私人 PAT 和领取偏好（完整 reset 保持 T031 语义）。
  app.post('/api/config/reset-selection', async (_req, reply) => {
    const defaults = buildDefaultConfig();
    const cfg = { ...store.get(), adapters: defaults.adapters, models: defaults.models };
    try {
      saveConfigToPath(configPath, cfg);
      store.set(cfg);
      return { ok: true, config: publicConfig(cfg) };
    } catch {
      return reply.code(400).send({ error: { message: '选择未能重置，请检查本机配置文件和写入权限' } });
    }
  });

  // 只允许固定 family 白名单；family 不会参与磁盘路径拼接。
  app.get<{ Params: { family: string } }>('/ui/app-icons/:family.png', async (req, reply) => {
    const family = req.params.family;
    if (!['workbuddy', 'dsh', 'hermes', 'minimax-code', 'trae', 'qoder'].includes(family)) {
      return reply.code(404).send({ error: { message: '图标暂不可用' } });
    }
    let icon: Buffer | undefined;
    try {
      icon = family === 'workbuddy' && opts.workBuddyIconLoader
        ? opts.workBuddyIconLoader()
        : opts.localAppIconLoader
          ? opts.localAppIconLoader(family as LocalAppIconFamily)
          : readInstalledAppIcon(family);
    } catch {
      return reply.code(404).send({ error: { message: '图标暂不可用' } });
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=300');
    if (!icon) return reply.code(404).send({ error: { message: '图标未安装' } });
    return reply.type('image/png').send(icon);
  });
  app.get('/ui/app-icons/workbuddy.png', async (_req, reply) => {
    let icon: Buffer | undefined;
    try { icon = opts.workBuddyIconLoader ? opts.workBuddyIconLoader() : readInstalledWorkBuddyIcon(); }
    catch { return reply.code(404).send({ error: { message: 'WorkBuddy 图标暂不可用' } }); }
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=300');
    if (!icon) return reply.code(404).send({ error: { message: 'WorkBuddy 图标未安装' } });
    return reply.type('image/png').send(icon);
  });

  // 静态资源：先打 /ui 主入口，再放兜底（避免 fastify 拦截 GET /ui/app.js）
  if (existsSync(join(assetsDir, 'index.html'))) {
    // 浏览器从 /ui 进入时，相对路径 ./style.css 会解析到 /style.css.
    // 301 到 /ui/ 让 ./style.css 解析到 /ui/style.css。
    app.get('/ui', async (_req, reply) => {
      return reply.code(301).redirect('/ui/');
    });
    app.get('/ui/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      return reply.send(createReadStream(join(assetsDir, 'index.html')));
    });
    // 其余静态资源（app.js、style.css）；app.ts 在 dev/test 时按需用 esbuild 转译。
    app.get('/ui/:file', async (req, reply) => {
      const file = (req.params as { file?: string }).file ?? '';
      if (file.includes('/') || file.includes('..')) {
        return reply.code(400).send({ error: { message: '非法文件名' } });
      }
      const target = resolve(join(assetsDir, file));
      if (!target.startsWith(resolve(assetsDir) + '/') && target !== assetsDir) {
        return reply.code(400).send({ error: { message: '非法路径' } });
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        // dev/test 兜底：若请求 .js 但只有 .ts 源文件，用 esbuild 转译
        if (file.endsWith('.js')) {
          const tsSource = target.replace(/\.js$/, '.ts');
          if (existsSync(tsSource) && statSync(tsSource).isFile()) {
            return reply.type('application/javascript; charset=utf-8').send(
              await transpileTsFile(tsSource),
            );
          }
        }
        return reply.code(404).send({ error: { message: '资源不存在' } });
      }
      const ct = mimeFor(file);
      if (ct) reply.type(ct);
      return reply.send(createReadStream(target));
    });
  }
}

/** 把 store 中的 allowlist 解释成可路由判定：返回判定函数 */
export function makeRouteFilter(store: ConfigStore): (adapterId: string, modelId: string) => boolean {
  return (adapterId: string, modelId: string): boolean => {
    const cfg = store.get();
    if (!cfg.adapters[adapterId]?.enabled) return false;
    const allow = cfg.models.allow[adapterId];
    if (!allow) return true; // 空 allowlist 默认放行
    const v = allow[modelId];
    return v === undefined ? true : v;
  };
}

/** 简易 MIME 映射（避免引入 mime 依赖） */
function mimeFor(file: string): string | undefined {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'application/javascript; charset=utf-8';
    case '.mjs':  return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg':  return 'image/svg+xml';
    case '.png':  return 'image/png';
    case '.ico':  return 'image/x-icon';
    default:      return undefined;
  }
}

/** dev/test 兜底：把 src/ui/public/app.ts 转译为浏览器可执行的 ESM */
async function transpileTsFile(path: string): Promise<string> {
  const src = readFileSync(path, 'utf8');
  const out = await transform(src, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });
  return out.code;
}

/** 工具：CLI 调用方在程序启动时把配置文件路径解析出来、加载或初始化 */
export function loadOrInitStore(path: string): { store: ConfigStore; created: boolean } {
  if (!existsSync(path)) {
    const cfg = buildDefaultConfig();
    saveConfigToPath(path, cfg);
    return { store: new ConfigStore(cfg), created: true };
  }
  const cfg = loadConfigFromPath(path);
  return { store: new ConfigStore(cfg), created: false };
}
