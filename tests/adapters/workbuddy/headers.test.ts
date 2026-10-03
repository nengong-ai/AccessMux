// WorkBuddy header 拼装（四轮返工按 dsh-workbuddy-connect/upstream.ts:179/373-421
// + client-identity.ts:122-133 重写后的行为）。
import { describe, expect, it } from 'vitest';
import {
  CLIENT_UA,
  buildWorkBuddyCatalogHeaders,
  buildWorkBuddyChatHeaders,
  buildWorkBuddyRefreshHeaders,
  chatUserAgent,
} from '../../../src/adapters/workbuddy/headers.js';

describe('chatUserAgent', () => {
  it('CN 形状：WorkBuddy/<v> WorkBuddy/<v>', () => {
    expect(chatUserAgent({ clientVersion: '5.6.2' }, 'cn')).toBe('WorkBuddy/5.6.2 WorkBuddy/5.6.2');
  });

  it('Global 形状：WorkBuddy/<v> WorkBuddy AI/<v>', () => {
    expect(chatUserAgent({ clientVersion: '5.5.2' }, 'global')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2');
  });

  it('cliVersion 存在时追加 CLI/<v> 段', () => {
    expect(chatUserAgent({ clientVersion: '5.6.2', cliVersion: '2.137.1' }, 'cn'))
      .toBe('WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/2.137.1');
  });

  it('非法版本（会进 header 的值）直接抛错', () => {
    expect(() => chatUserAgent({ clientVersion: 'bad version' }, 'cn')).toThrow(/invalid client version/);
    expect(() => chatUserAgent({ clientVersion: '' }, 'cn')).toThrow(/invalid client version/);
  });
});

describe('buildWorkBuddyChatHeaders', () => {
  it('dsh chat headers 全集：Authorization + X-User-Id + X-IDE-* + X-Product + UA + Origin/Referer', () => {
    const headers = buildWorkBuddyChatHeaders(
      { accessToken: 'jwt.here', userId: 'u1', domain: 'ide.codebuddy.cn' },
      { clientVersion: '5.6.2' },
      'cn',
    );
    expect(headers['Authorization']).toBe('Bearer jwt.here');
    expect(headers['X-User-Id']).toBe('u1');
    expect(headers['X-Domain']).toBe('ide.codebuddy.cn');
    expect(headers['X-IDE-Type']).toBe('WorkBuddy');
    expect(headers['X-IDE-Name']).toBe('WorkBuddy');
    expect(headers['X-IDE-Version']).toBe('5.6.2');
    expect(headers['X-Product']).toBe('SaaS');
    expect(headers['User-Agent']).toBe('WorkBuddy/5.6.2 WorkBuddy/5.6.2');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(headers['Origin']).toBe('https://www.codebuddy.cn');
    expect(headers['Referer']).toBe('https://www.codebuddy.cn/');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('缺 uid / enterpriseId / domain 时走 X-No-* 变体（官方 CLI 约定）', () => {
    const headers = buildWorkBuddyChatHeaders(
      { accessToken: 'jwt' },
      { clientVersion: '5.6.2' },
      'cn',
    );
    expect(headers['X-No-User-Id']).toBe('1');
    expect(headers['X-No-Enterprise-Id']).toBe('1');
    expect(headers['X-No-Department-Info']).toBe('1');
    expect(headers['X-User-Id']).toBeUndefined();
  });

  it('enterpriseId 存在时带 X-Enterprise-Id', () => {
    const headers = buildWorkBuddyChatHeaders(
      { accessToken: 'jwt', userId: 'u', enterpriseId: 'ent-1' },
      { clientVersion: '5.6.2' },
      'cn',
    );
    expect(headers['X-Enterprise-Id']).toBe('ent-1');
    expect(headers['X-No-Enterprise-Id']).toBeUndefined();
  });

  it('Global 的 Origin/Referer 走 workbuddy.ai', () => {
    const headers = buildWorkBuddyChatHeaders(
      { accessToken: 'jwt' },
      { clientVersion: '5.5.2' },
      'global',
    );
    expect(headers['Origin']).toBe('https://www.workbuddy.ai');
    expect(headers['Referer']).toBe('https://www.workbuddy.ai/');
  });
});

describe('buildWorkBuddyCatalogHeaders', () => {
  it('CN catalog：CLIENT_UA + Authorization + Accept json + Origin/Referer，无 X-Requested-With/X-Product', () => {
    const headers = buildWorkBuddyCatalogHeaders({ accessToken: 'jwt' }, 'cn');
    expect(headers['Authorization']).toBe('Bearer jwt');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['User-Agent']).toBe(CLIENT_UA);
    expect(headers['Origin']).toBe('https://www.codebuddy.cn');
    expect(headers['X-Requested-With']).toBeUndefined();
    expect(headers['X-Product']).toBeUndefined();
  });
});

describe('buildWorkBuddyRefreshHeaders', () => {
  it('refresh：X-Refresh-Token 只在这里出现 + X-Auth-Refresh-Source + CLIENT_UA', () => {
    const headers = buildWorkBuddyRefreshHeaders(
      { accessToken: '', userId: '', refreshToken: 'rt-jwt' },
      'cn',
    );
    expect(headers['X-Refresh-Token']).toBe('rt-jwt');
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy');
    expect(headers['User-Agent']).toBe(CLIENT_UA);
    expect(headers['Origin']).toBe('https://www.codebuddy.cn');
  });

  it('refresh headers 不带 Authorization（refresh JWT 走 X-Refresh-Token）', () => {
    const headers = buildWorkBuddyRefreshHeaders(
      { accessToken: 'access', userId: '', refreshToken: 'rt' },
      'cn',
    );
    expect(headers['Authorization']).toBeUndefined();
  });

  it('enterpriseId 存在时带 X-Enterprise-Id', () => {
    const headers = buildWorkBuddyRefreshHeaders(
      { accessToken: '', userId: '', refreshToken: 'rt', enterpriseId: 'ent' },
      'cn',
    );
    expect(headers['X-Enterprise-Id']).toBe('ent');
  });
});
