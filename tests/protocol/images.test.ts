// T036 协议层图片归一单元测试：魔数嗅探、四格式尺寸解析、上限校验、
// data URI / base64 解析、URL 拉取（注入 fetch）。全部离线，图片用
// tests/fixtures 自制标记图（T036 点阵字）与合成头部。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAdapterAcceptsImages,
  assertImageCount,
  imageDimensions,
  imagePartFromBase64,
  imagePartFromBytes,
  imagePartFromDataUri,
  imagePartFromUrl,
  ImageInputError,
  MAX_IMAGE_EDGE_PX,
  MAX_IMAGES_PER_REQUEST,
  sniffImageMediaType,
} from '../../src/protocol/images.js';

const FIXTURES = join(import.meta.dirname, '../fixtures');
const markerPng = new Uint8Array(readFileSync(join(FIXTURES, 'image-marker.png')));
const markerJpg = new Uint8Array(readFileSync(join(FIXTURES, 'image-marker.jpg')));
const markerPngBase64 = Buffer.from(markerPng).toString('base64');

describe('sniffImageMediaType', () => {
  it('识别 PNG / JPEG fixture', () => {
    expect(sniffImageMediaType(markerPng)).toBe('image/png');
    expect(sniffImageMediaType(markerJpg)).toBe('image/jpeg');
  });

  it('识别 GIF / WebP 魔数（合成头部）', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x0a, 0x00]);
    expect(sniffImageMediaType(gif)).toBe('image/gif');
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMediaType(webp)).toBe('image/webp');
  });

  it('未知字节 → undefined', () => {
    expect(sniffImageMediaType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
  });
});

describe('imageDimensions', () => {
  it('PNG fixture：108x44（自制标记图实际尺寸）', () => {
    expect(imageDimensions(markerPng)).toEqual({ width: 108, height: 44 });
  });

  it('JPEG fixture：可解析且尺寸与 sips 输出一致', () => {
    // sips 不缩放，仅转码；宽高应与 PNG 相同
    expect(imageDimensions(markerJpg)).toEqual({ width: 108, height: 44 });
  });

  it('GIF 逻辑屏幕尺寸（LE）', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x0a, 0x00]);
    expect(imageDimensions(gif)).toEqual({ width: 16, height: 10 });
  });

  it('WebP VP8L：14bit 位域尺寸', () => {
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
    webp[20] = 0x2f; // lossless 签名
    // width-1=107(0x6B)、height-1=43(0x2B) 打进 4 字节 LE 位域
    const bits = (107 & 0x3fff) | ((43 & 0x3fff) << 14);
    new DataView(webp.buffer).setUint32(21, bits, true);
    expect(imageDimensions(webp)).toEqual({ width: 108, height: 44 });
  });

  it('WebP VP8X：24bit canvas 尺寸', () => {
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
    webp[24] = 107; webp[25] = 0; webp[26] = 0; // width-1
    webp[27] = 43; webp[28] = 0; webp[29] = 0; // height-1
    expect(imageDimensions(webp)).toEqual({ width: 108, height: 44 });
  });
});

describe('imagePartFromBytes / imagePartFromBase64', () => {
  it('PNG base64 → ImagePart（mediaType 嗅探、data 原样回填）', () => {
    const part = imagePartFromBase64(markerPngBase64);
    expect(part).toEqual({ type: 'image', mediaType: 'image/png', data: markerPngBase64 });
  });

  it('空数据 / 非 base64 字符 → 小白可读报错', () => {
    expect(() => imagePartFromBase64('')).toThrow(ImageInputError);
    expect(() => imagePartFromBase64('不是base64!!')).toThrow(/base64 数据不合法/);
  });

  it('未知字节（伪装 png 的垃圾）→ 报无法识别格式', () => {
    const junk = Buffer.from('hello world garbage').toString('base64');
    expect(() => imagePartFromBase64(junk)).toThrow(/无法识别的图片格式/);
  });

  it('超 5MB → 报体积上限', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    big.set(markerPng, 0); // 魔数头合法，体积超限
    expect(() => imagePartFromBytes(big, () => '')).toThrow(/图片过大/);
  });

  it('单边超 8000px → 报分辨率上限（合成 PNG 头）', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 8001);
    view.setUint32(20, 100);
    expect(() => imagePartFromBytes(png, () => '')).toThrow(new RegExp(String(MAX_IMAGE_EDGE_PX)));
  });
});

describe('imagePartFromDataUri', () => {
  it('标准 data URI → PNG part', () => {
    const part = imagePartFromDataUri(`data:image/png;base64,${markerPngBase64}`);
    expect(part.mediaType).toBe('image/png');
    expect(part.data).toBe(markerPngBase64);
  });

  it('声明 mime 与字节不符时以字节为准', () => {
    const part = imagePartFromDataUri(`data:image/jpeg;base64,${markerPngBase64}`);
    expect(part.mediaType).toBe('image/png');
  });

  it('非 base64 data URI / 残缺形态 → 报错', () => {
    expect(() => imagePartFromDataUri('data:image/png,rawbytes')).toThrow(/data URL 不合规/);
    expect(() => imagePartFromDataUri('http://example.test/x.png')).toThrow(/data URL 不合规/);
  });
});

describe('imagePartFromUrl', () => {
  it('http URL → 下载并归一（注入 fetchImpl）', async () => {
    const fetchImpl = (async () => new Response(markerPng as unknown as BodyInit, { status: 200 })) as typeof fetch;
    const part = await imagePartFromUrl('https://example.test/marker.png', { fetchImpl });
    expect(part.mediaType).toBe('image/png');
    expect(part.data).toBe(markerPngBase64);
  });

  it('非 http 协议（file://）→ 报协议不支持', async () => {
    await expect(imagePartFromUrl('file:///tmp/x.png')).rejects.toThrow(/协议不支持/);
  });

  it('HTTP 404 → 报下载失败', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(imagePartFromUrl('https://example.test/gone.png', { fetchImpl })).rejects.toThrow(/下载失败（HTTP 404）/);
  });

  it('下载超预算即断开（伪造无限流）', async () => {
    const huge = new Uint8Array(6 * 1024 * 1024); // 6MB > 5MB 上限
    huge.set(markerPng, 0);
    const fetchImpl = (async () => new Response(huge as unknown as BodyInit, { status: 200 })) as typeof fetch;
    await expect(imagePartFromUrl('https://example.test/huge.png', { fetchImpl })).rejects.toThrow(/图片过大/);
  });

  it('网络错误 → 报下载失败', async () => {
    const fetchImpl = (async () => { throw new TypeError('connect refused'); }) as unknown as typeof fetch;
    await expect(imagePartFromUrl('https://down.test/x.png', { fetchImpl })).rejects.toThrow(/下载失败/);
  });
});

describe('请求级门禁', () => {
  it('超过单请求图片数上限 → 报数量上限', () => {
    const images = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => ({
      type: 'image' as const,
      mediaType: 'image/png' as const,
      data: markerPngBase64,
    }));
    expect(() => assertImageCount(images)).toThrow(/最多带/);
    expect(() => assertImageCount(images.slice(0, MAX_IMAGES_PER_REQUEST))).not.toThrow();
  });

  it('未点亮源收到图片 → 明确拒绝；点亮源放行', () => {
    const gray = { id: 'gray', displayName: 'Gray Source' };
    const lit = { id: 'lit', displayName: 'Lit', bridgeImages: true };
    expect(() => assertAdapterAcceptsImages(gray, 1)).toThrow(/暂不支持图片输入/);
    expect(() => assertAdapterAcceptsImages(gray, 0)).not.toThrow();
    expect(() => assertAdapterAcceptsImages(lit, 1)).not.toThrow();
  });
});
