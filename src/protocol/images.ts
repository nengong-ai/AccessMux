// T036 图片输入归一（协议层）：把 OpenAI image_url（http URL / base64 data URI）
// 与 Anthropic image block 的载荷统一成内部 ImagePart，并在入口做体积/尺寸/
// 数量上限校验。错误文案面向小白（说清楚哪里不合规、怎么办），图片本体
// 不进日志（只上报计数与格式）。
//
// 校验策略：字节为准（魔数嗅探定真实格式，声明类型仅作参考），未识别的
// 字节流一律 400，不做服务端转码/缩放。

import type { ChatMessage, ImagePart } from '../types.js';

export const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

/** 单张解码后字节上限（与 Anthropic base64 图片限制一致）。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 单边像素上限（Anthropic 口径；超过应在上游/客户端先缩放）。 */
export const MAX_IMAGE_EDGE_PX = 8000;
/** 单次请求图片总数上限。 */
export const MAX_IMAGES_PER_REQUEST = 8;
/** URL 图片下载预算。 */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** 图片输入不合规：协议层统一映射 400 invalid_request（小白可读文案）。 */
export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputError';
  }
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/* ---------- 魔数嗅探 ---------- */

/** 按字节头识别四种支持格式；识别不出返回 undefined。 */
export function sniffImageMediaType(bytes: Uint8Array): SupportedImageMediaType | undefined {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 6
      && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
      && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/* ---------- 尺寸解析（纯函数，四种格式各取头部） ---------- */

export interface ImageDimensions {
  width: number;
  height: number;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // IHDR 固定在 8 字节签名后：长度 4 + "IHDR" 4，随后 width/height 各 BE u32。
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // 逐 marker 扫到第一个 SOF 帧（C0-CF，剔除 C4/C8/CC），帧头内 height/width 各 BE u16。
  const byte = (i: number): number => bytes[i] ?? 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (byte(offset) !== 0xff) return undefined;
    const marker = byte(offset + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const byte = (i: number): number => bytes[i] ?? 0;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8 ') {
    // lossy：3 字节帧 tag + 3 字节同步码，随后 14bit width/height（LE）。
    const width = ((byte(26) & 0x3f) << 8) | byte(25);
    const height = ((byte(28) & 0x3f) << 8) | byte(27);
    return { width, height };
  }
  if (chunk === 'VP8L') {
    // lossless：签名 0x2F 后 4 字节 LE 位域（14bit width-1 / 14bit height-1）。
    if (byte(20) !== 0x2f) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // extended：24bit LE 的 canvas width-1 / height-1。
    const w = byte(24) | (byte(25) << 8) | (byte(26) << 16);
    const h = byte(27) | (byte(28) << 8) | (byte(29) << 16);
    return { width: w + 1, height: h + 1 };
  }
  return undefined;
}

/** 解析图片像素尺寸；头部缺失/损坏返回 undefined（调用方按无法识别处理）。 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  switch (sniffImageMediaType(bytes)) {
    case 'image/png': return pngDimensions(bytes);
    case 'image/gif': return gifDimensions(bytes);
    case 'image/jpeg': return jpegDimensions(bytes);
    case 'image/webp': return webpDimensions(bytes);
    default: return undefined;
  }
}

/* ---------- 归一入口 ---------- */

/** 字节 → 受检 ImagePart（嗅探格式 + 体积/尺寸上限）。base64 用原始串回填。 */
export function imagePartFromBytes(bytes: Uint8Array, toBase64: () => string): ImagePart {
  if (bytes.length === 0) throw new ImageInputError('图片数据为空：请检查图片文件是否损坏');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError(`图片过大（${formatBytes(bytes.length)}）：单张上限 5MB，请压缩或截小后再发`);
  }
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) {
    throw new ImageInputError('无法识别的图片格式（可能是 BMP/HEIC 等）：目前支持 PNG / JPEG / GIF / WebP');
  }
  const dims = imageDimensions(bytes);
  if (dims === undefined) {
    throw new ImageInputError('图片文件头不完整或已损坏，读不出尺寸：请重新导出后再发');
  }
  if (dims.width > MAX_IMAGE_EDGE_PX || dims.height > MAX_IMAGE_EDGE_PX) {
    throw new ImageInputError(
      `图片分辨率过大（${dims.width}×${dims.height}）：单边上限 ${MAX_IMAGE_EDGE_PX} 像素，请缩小后再发`,
    );
  }
  return { type: 'image', mediaType, data: toBase64() };
}

const BASE64_BODY = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/** base64 载荷（Anthropic source.data 或 data URI payload）→ 受检 ImagePart。 */
export function imagePartFromBase64(base64: string): ImagePart {
  const trimmed = base64.replace(/\s+/g, '');
  if (trimmed === '' || !BASE64_BODY.test(trimmed)) {
    throw new ImageInputError('图片 base64 数据不合法：请确认发送的是完整的 base64 图片内容');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  return imagePartFromBytes(new Uint8Array(decoded), () => trimmed);
}

/** `data:image/png;base64,AAAA` 形态 → 受检 ImagePart。 */
export function imagePartFromDataUri(uri: string): ImagePart {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (match === null || match[2] === undefined) {
    throw new ImageInputError('图片 data URL 不合规：需要 data:<类型>;base64,<数据> 形态');
  }
  // 声明的 mime 只做参考，真实格式以字节嗅探为准。
  return imagePartFromBase64(match[3] ?? '');
}

export interface ImageFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** http(s) 图片链接 → 受检 ImagePart（流式下载，超预算即断开）。 */
export async function imagePartFromUrl(url: string, opts: ImageFetchOptions = {}): Promise<ImagePart> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageInputError('图片链接不合法：请检查 URL 或改用 base64 data URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImageInputError(`图片链接协议不支持（${parsed.protocol}）：仅支持 http/https 链接或 base64 data URL`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), IMAGE_FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(parsed.href, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    const reason = controller.signal.aborted ? '下载超时或被取消' : '网络错误';
    throw new ImageInputError(`图片下载失败（${reason}）：请检查链接，或把图片保存下来用 base64 data URL 发送（${err instanceof Error ? err.name : 'fetch error'}）`);
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
  if (!response.ok) {
    throw new ImageInputError(`图片下载失败（HTTP ${response.status}）：链接可能已失效，请检查后重试`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          chunks.push(value);
          total += value.length;
          if (total > MAX_IMAGE_BYTES) {
            throw new ImageInputError(`图片过大（已下载 ${formatBytes(total)}+）：单张上限 5MB，请压缩或截小后再发`);
          }
        }
      }
    } finally {
      // 错误/超限都要断开连接，不留悬挂下载。
      void reader.cancel().catch(() => undefined);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    total = buffer.length;
  }
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return imagePartFromBytes(merged, () => Buffer.from(merged).toString('base64'));
}

/* ---------- 请求级门禁 ---------- */

/** 请求内图片总数。 */
export function countRequestImages(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
}

export function messagesHaveImages(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => (m.images?.length ?? 0) > 0);
}

/** 数量上限（在归一逐张校验之后、进 adapter 之前再核一次总量）。 */
export function assertImageCount(images: readonly ImagePart[]): void {
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    throw new ImageInputError(`一次请求最多带 ${MAX_IMAGES_PER_REQUEST} 张图片（本次 ${images.length} 张）`);
  }
}

export interface ImageCapableAdapter {
  /** T036：源级图片路径是否已点亮（真机往返验证过才为 true）。 */
  readonly bridgeImages?: boolean;
}

/** 未点亮图片的源收到带图请求 → 明确报错（小白可读），不静默丢图。 */
export function assertAdapterAcceptsImages(
  adapter: ImageCapableAdapter & { id: string; displayName?: string },
  imageCount: number,
): void {
  if (adapter.bridgeImages === true || imageCount === 0) return;
  throw new ImageInputError(
    `${adapter.displayName ?? adapter.id} 源暂不支持图片输入（能力未点亮）：该源的文字请求不受影响，图片请换已点亮视觉的源发送`,
  );
}
