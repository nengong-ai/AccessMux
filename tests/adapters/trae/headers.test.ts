// Trae header 拼装测试。

import { describe, expect, it } from 'vitest';
import { buildTraeHeaders, normalizeTraeVersionCode, TRAE_VERSION_CODE_FALLBACK } from '../../../src/adapters/trae/headers.js';
import type { TraeIdentity } from '../../../src/adapters/trae/identity.js';

const baseIdentity: TraeIdentity = {
  edition: 'cn',
  machineId: 'machine-id-12345678901234567890',
  deviceId: 'device-id-1234567890',
  appVersion: '1.2.3',
  buildVersion: '20260518',
  platform: 'darwin',
};

describe('normalizeTraeVersionCode', () => {
  it('undefined / 空 → fallback', () => {
    expect(normalizeTraeVersionCode(undefined)).toBe(TRAE_VERSION_CODE_FALLBACK);
    expect(normalizeTraeVersionCode('')).toBe(TRAE_VERSION_CODE_FALLBACK);
    expect(normalizeTraeVersionCode('   ')).toBe(TRAE_VERSION_CODE_FALLBACK);
  });

  it('dotted version → fallback（防止 4001）', () => {
    expect(normalizeTraeVersionCode('2.3.76922')).toBe(TRAE_VERSION_CODE_FALLBACK);
  });

  it('纯数字保留', () => {
    expect(normalizeTraeVersionCode('20260518')).toBe('20260518');
  });
});

describe('buildTraeHeaders', () => {
  it('agent-task profile 必含 Authorization + x-uid + trace id', () => {
    const headers = buildTraeHeaders(
      { accessToken: 'tkn', userId: 'uid-1' },
      baseIdentity,
    );
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT tkn');
    expect(headers['X-Ide-Token']).toBe('tkn');
    expect(headers['X-Cloudide-Token']).toBe('tkn');
    expect(headers['x-uid']).toBe('uid-1');
    expect(headers['x-app-version-code']).toBe('20260518');
    expect(headers['x-ide-version-code']).toBe('20260518');
    expect(headers['x-machine-id']).toBe(baseIdentity.machineId);
    expect(headers['x-device-id']).toBe(baseIdentity.deviceId);
    expect(headers['x-device-type']).toBe('mac');
    expect(headers['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-custom-trace-id']).toMatch(/^[a-f0-9]{32}$/);
    expect(headers['x-flow-traceparent']).toMatch(/^04-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  });

  it('dotted build version 走 fallback 不污染 header', () => {
    const headers = buildTraeHeaders(
      { accessToken: 'tkn', userId: 'uid-1' },
      { ...baseIdentity, buildVersion: '2.3.76922' },
    );
    expect(headers['x-app-version-code']).toBe(TRAE_VERSION_CODE_FALLBACK);
    expect(headers['x-ide-version-code']).toBe(TRAE_VERSION_CODE_FALLBACK);
  });

  it('model-detail profile 加 Accept: application/json', () => {
    const headers = buildTraeHeaders({ accessToken: 't', userId: 'u' }, baseIdentity, { profile: 'model-detail' });
    expect(headers['Accept']).toBe('application/json');
  });

  it('raw-chat profile 加 Accept: text/event-stream', () => {
    const headers = buildTraeHeaders({ accessToken: 't', userId: 'u' }, baseIdentity, { profile: 'raw-chat' });
    expect(headers['Accept']).toBe('text/event-stream');
  });

  it('native-curl profile 不带 Authorization / User-Agent', () => {
    const headers = buildTraeHeaders({ accessToken: 't', userId: 'u' }, baseIdentity, { profile: 'native-curl' });
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['X-Ide-Token']).toBe('t');
  });

  it('Windows identity 用 windows 而非 mac', () => {
    const headers = buildTraeHeaders(
      { accessToken: 't', userId: 'u' },
      { ...baseIdentity, platform: 'win32' },
    );
    expect(headers['x-device-type']).toBe('windows');
  });

  it('device brand 仅 macOS 出现', () => {
    const mac = buildTraeHeaders(
      { accessToken: 't', userId: 'u' },
      { ...baseIdentity, deviceBrand: 'Apple' },
    );
    expect(mac['x-device-brand']).toBe('Apple');
    const win = buildTraeHeaders(
      { accessToken: 't', userId: 'u' },
      { ...baseIdentity, platform: 'win32', deviceBrand: 'Apple' },
    );
    expect(win['x-device-brand']).toBeUndefined();
  });
});