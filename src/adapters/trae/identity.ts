// Trae identity 解析（D11 + 端口 spec §3.2 + §3.2.10 协议事实）。
//
// 单一来源：traeStorageCandidates + 候选 `storage.json` 里的 telemetry.machineId /
// icube-dc:<id>；product.json 的 appVersion（macOS/Win）。CLI-only 场景退而
// 缺少官方 machine/device 字段时不可用，CLI crash reporter 不能替代设备身份。
//
// 只读既有官方身份字段；缺字段就 unavailable，不从主机、用户或其他标识派生。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cpus, homedir, release } from 'node:os';
import type { TraeEdition, TraeStorageCandidate } from './paths.js';
import { traeWindowsAppNames } from './paths.js';

export interface TraeIdentity {
  edition: TraeEdition;
  machineId: string;
  deviceId: string;
  appVersion?: string;
  buildVersion?: string;
  deviceBrand?: string;
  deviceCpu?: string;
  osVersion?: string;
  platform: NodeJS.Platform;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function deviceCenterId(storage: Record<string, unknown>): string | undefined {
  const prefix = 'iCubeAuthInfo://icube-dc:';
  const ids = Object.keys(storage)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((s) => s !== '');
  return ids.length === 1 ? ids[0] : undefined;
}

export interface TraeIdentityReadOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 从桌面 `storage.json` 与相邻 product.json 拼装 identity。
 * - telemetry.machineId（首选）→ root `machineid` 文件（备选）
 * - deviceId：icube-dc:<id> → telemetry.devDeviceId; missing means unavailable
 * - buildVersion：iCubeLastVersion（必须是纯数字，否则归一化 fallback）
 * - appVersion：product.json.appVersion
 */
export async function readTraeIdentity(
  candidate: TraeStorageCandidate,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const raw = await readFile(candidate.path, 'utf8');
  let storage: Record<string, unknown>;
  try { storage = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('Trae official identity storage is not valid JSON'); }
  if (typeof storage !== 'object' || storage === null || Array.isArray(storage)) throw new Error('Trae official identity storage is not an object');
  const appRoot = dirname(dirname(dirname(candidate.path)));
  const machineFile = nonEmpty(await readFile(join(appRoot, 'machineid'), 'utf8').catch(() => ''));
  const telemetryMachine = nonEmpty(storage['telemetry.machineId']);
  const devDevice = nonEmpty(storage['telemetry.devDeviceId']);
  const dcDevice = deviceCenterId(storage);
  const machineId = telemetryMachine ?? machineFile;
  if (machineId === undefined) {
    throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
  }
  const deviceId = dcDevice ?? devDevice;
  if (deviceId === undefined) throw new Error(`Trae ${candidate.edition} official device identity unavailable`);
  const buildVersion = nonEmpty(storage['iCubeLastVersion']);

  // product.json：macOS 在 app bundle 内，Windows 在 Programs/<install>/resources/app
  const APP_NAMES_BY_EDITION: Readonly<Record<TraeEdition, string>> = {
    cn: 'Trae CN',
    sg: 'Trae',
    solo: 'TRAE SOLO CN',
    'solo-sg': 'TRAE SOLO',
  };
  const appName = APP_NAMES_BY_EDITION[candidate.edition];
  const productPaths: string[] = [];
  if (appName !== undefined && (platform === 'darwin' || platform === 'win32')) {
    if (platform === 'darwin') {
      productPaths.push(join('/Applications', `${appName}.app`, 'Contents', 'Resources', 'app', 'product.json'));
    } else {
      const localRoots = [env.LOCALAPPDATA, join(home, 'AppData', 'Local')]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .filter((value, index, all) => all.indexOf(value) === index);
      for (const root of localRoots) {
        for (const spelling of traeWindowsAppNames(candidate.edition)) {
          productPaths.push(join(root, 'Programs', spelling, 'resources', 'app', 'product.json'));
        }
      }
    }
  }
  let product: Record<string, unknown> = {};
  for (const path of productPaths) {
    try {
      product = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      break;
    } catch {
      // 下一个候选
    }
  }
  const appVersion = nonEmpty(product['appVersion']);
  const deviceBrand = platform === 'darwin' ? nonEmpty(env['TRAE_DEVICE_BRAND']) : undefined;
  const deviceCpu = cpus()[0]?.model.split(' ')[0];
  const osVersion = `${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform} ${release()}`;
  return {
    edition: candidate.edition,
    machineId,
    deviceId,
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(buildVersion === undefined ? {} : { buildVersion }),
    ...(deviceBrand === undefined ? {} : { deviceBrand }),
    ...(deviceCpu === undefined ? {} : { deviceCpu }),
    osVersion,
    platform,
  };
}

function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

const STORAGE_MISSING_PREFIX = 'Trae storage was not found';

/**
 * 顺序遍历候选；缺文件就跳过（不让一个不存在的 candidate 拖垮其他）。
 * 全部缺失抛 `STORAGE_MISSING_PREFIX` 让上层（resolveTraeIdentity）走 CLI fallback。
 */
export async function pickTraeStorageIdentity(
  candidates: readonly TraeStorageCandidate[],
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  let lastError: unknown;
  let anyPresent = false;
  for (const candidate of candidates) {
    try {
      return await readTraeIdentity(candidate, options);
    } catch (error) {
      lastError = error;
      if (!isFileMissing(error)) anyPresent = true;
    }
  }
  const tried = candidates.map((c) => c.path).join(' or ');
  if (!anyPresent) throw new Error(`${STORAGE_MISSING_PREFIX} (${tried})`);
  throw lastError instanceof Error ? lastError : new Error(`Trae identity could not be resolved (${tried})`);
}

/** CLI credentials do not provide both official identity fields. Never synthesize them. */
export async function readTraeCliIdentity(
  edition: TraeEdition,
  _options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  throw new Error(`Trae ${edition} official device identity unavailable for CLI-only credentials`);
}

/**
 * 只读取既有官方 storage identity；CLI-only 不具备完整身份，明确 unavailable。
 */
export async function resolveTraeIdentity(
  candidates: readonly TraeStorageCandidate[],
  edition: TraeEdition,
  options: TraeIdentityReadOptions = {},
): Promise<TraeIdentity> {
  try {
    return await pickTraeStorageIdentity(candidates, options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(STORAGE_MISSING_PREFIX)) throw error;
    return readTraeCliIdentity(edition, options);
  }
}