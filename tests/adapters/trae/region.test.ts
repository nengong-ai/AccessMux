// Trae 区域解析测试。

import { describe, expect, it } from 'vitest';
import {
  REGION_GATEWAYS,
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
} from '../../../src/adapters/trae/region.js';

describe('regionOfEdition', () => {
  it('cn / solo → cn', () => {
    expect(regionOfEdition('cn')).toBe('cn');
    expect(regionOfEdition('solo')).toBe('cn');
  });
  it('sg / solo-sg → ai', () => {
    expect(regionOfEdition('sg')).toBe('ai');
    expect(regionOfEdition('solo-sg')).toBe('ai');
  });
});

describe('regionOfUserRegion', () => {
  it('字符串 "CN" → cn', () => {
    expect(regionOfUserRegion('CN')).toBe('cn');
  });
  it('小写 "sg" → ai', () => {
    expect(regionOfUserRegion('sg')).toBe('ai');
  });
  it('ai 也归 ai', () => {
    expect(regionOfUserRegion('AI')).toBe('ai');
  });
  it('object {region:"CN"} → cn', () => {
    expect(regionOfUserRegion({ region: 'CN' })).toBe('cn');
  });
  it('其他字符串 → undefined', () => {
    expect(regionOfUserRegion('XX')).toBeUndefined();
  });
  it('非字符串非对象 → undefined', () => {
    expect(regionOfUserRegion(42)).toBeUndefined();
    expect(regionOfUserRegion(null)).toBeUndefined();
    expect(regionOfUserRegion([])).toBeUndefined();
  });
});

describe('regionOfHost', () => {
  it('trae.ai → ai', () => {
    expect(regionOfHost('https://api.trae.ai')).toBe('ai');
  });
  it('*.trae.ai → ai', () => {
    expect(regionOfHost('https://coresg-normal.trae.ai')).toBe('ai');
  });
  it('*.trae.cn → cn', () => {
    expect(regionOfHost('https://api.trae.cn')).toBe('cn');
  });
  it('*.trae.com.cn → cn', () => {
    expect(regionOfHost('https://something.trae.com.cn')).toBe('cn');
  });
  it('其他后缀 → undefined', () => {
    expect(regionOfHost('https://example.com')).toBeUndefined();
  });
  it('undefined / 空 → undefined', () => {
    expect(regionOfHost(undefined)).toBeUndefined();
    expect(regionOfHost('')).toBeUndefined();
  });
  it('无法 parse 的 host → undefined', () => {
    expect(regionOfHost('not a url at all')).toBeUndefined();
  });
});

describe('regionOfCredential 优先级', () => {
  it('userRegion 赢 over host / edition', () => {
    expect(regionOfCredential({ edition: 'sg', host: 'https://api.trae.cn', userRegion: 'SG' })).toBe('ai');
  });
  it('无 userRegion 时 host 优先', () => {
    expect(regionOfCredential({ edition: 'cn', host: 'https://api.trae.ai' })).toBe('ai');
  });
  it('只给 edition 时 fallback 到 edition', () => {
    expect(regionOfCredential({ edition: 'sg' })).toBe('ai');
  });
  it('空 userRegion / 空 host 都 fallback 到 edition', () => {
    expect(regionOfCredential({ edition: 'cn', host: '', userRegion: '' })).toBe('cn');
  });
});

describe('REGION_GATEWAYS', () => {
  it('CN / AI 各自 chat / remote / pay', () => {
    expect(REGION_GATEWAYS.cn.chat).toMatch(/^https:\/\//);
    expect(REGION_GATEWAYS.ai.chat).toMatch(/^https:\/\//);
    expect(REGION_GATEWAYS.cn.remote).toMatch(/solo\.trae\.cn/);
    expect(REGION_GATEWAYS.ai.remote).toMatch(/trae\.ai/);
    expect(REGION_GATEWAYS.cn.pay).toMatch(/trae\.cn$/);
    expect(REGION_GATEWAYS.ai.pay).toMatch(/trae\.ai$/);
  });
});