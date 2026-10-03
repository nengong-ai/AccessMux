import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_ICNS_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFERRED_CHUNKS = ['ic12', 'ic07', 'ic11'];
const ICNS_HEADER_SIZE = 8;
const APP_ICON_PATHS = {
  workbuddy: ['WorkBuddy.app/Contents/Resources/icon.icns'],
  dsh: ['DeepSeek Harness.app/Contents/Resources/icon.icns'],
  'claude-code': ['Claude.app/Contents/Resources/electron.icns'],
  codex: ['Codex.app/Contents/Resources/electron.icns'],
  hermes: ['Hermes.app/Contents/Resources/icon.icns'],
  'minimax-code': ['MiniMax Code.app/Contents/Resources/icon.icns'],
  trae: ['TRAE SOLO CN.app/Contents/Resources/TRAE SOLO CN.icns', 'Trae.app/Contents/Resources/Trae.icns'],
  qoder: ['Qoder CN.app/Contents/Resources/icon.icns', 'Qoder CN IDE.app/Contents/Resources/Qoder CN.icns'],
} as const;
export type LocalAppIconFamily = keyof typeof APP_ICON_PATHS;

export function extractPngFromIcns(data: Uint8Array): Buffer | undefined {
  if (data.byteLength < ICNS_HEADER_SIZE || data.byteLength > MAX_ICNS_BYTES) return undefined;
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) return undefined;
  const chunks = new Map<string, Buffer>();
  let offset = ICNS_HEADER_SIZE;
  while (offset < bytes.length) {
    if (bytes.length - offset < ICNS_HEADER_SIZE) return undefined;
    const type = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32BE(offset + 4);
    if (chunkLength < ICNS_HEADER_SIZE || chunkLength > bytes.length - offset) return undefined;
    const payload = bytes.subarray(offset + ICNS_HEADER_SIZE, offset + chunkLength);
    if (!chunks.has(type) && payload.length >= PNG_SIGNATURE.length && payload.subarray(0, 8).equals(PNG_SIGNATURE)) chunks.set(type, payload);
    offset += chunkLength;
  }
  for (const type of PREFERRED_CHUNKS) {
    const png = chunks.get(type);
    if (png !== undefined) return Buffer.from(png);
  }
  return undefined;
}

export function readInstalledAppIcon(family: string): Buffer | undefined {
  if (process.platform !== 'darwin' || !Object.hasOwn(APP_ICON_PATHS, family)) return undefined;
  const paths = APP_ICON_PATHS[family as LocalAppIconFamily].flatMap((relative) => [
    join('/Applications', relative), join(homedir(), 'Applications', relative),
  ]);
  for (const path of paths) {
    try {
      if (statSync(path).size > MAX_ICNS_BYTES) continue;
      const png = extractPngFromIcns(readFileSync(path));
      if (png !== undefined) return png;
    } catch {
      // Try the next supported application location.
    }
  }
  return undefined;
}

export function readInstalledWorkBuddyIcon(): Buffer | undefined {
  return readInstalledAppIcon('workbuddy');
}
