// redact util 测试。

describe('redactLogText 兼容与短鉴权回声', () => {
  it.each([
    'Authorization: Bearer short-B', 'Authorization: Basic short-B',
    'Cloud-IDE-JWT: short-B', 'pat=short-B', 'accessToken: short-B',
    'refresh_token=short-B', 'api_key=short-B', '{"pat":"short-B"}',
    'https://local.invalid/?token=short-B&other=ok',
  ])('不透出短凭据 %s', (text) => {
    expect(redactLogText(text)).not.toContain('short-B');
  });
  it('已知短原值精确替换，保留原有 maxLen 参数', () => {
    expect(redactLogText('upstream echoed xyZ', 300, ['xyZ'])).toBe('upstream echoed <redacted>');
    expect(redactLogText('ordinary text', 4)).toBe('ordi…');
    expect(redactLogText('正常诊断：HTTP 405')).toBe('正常诊断：HTTP 405');
  });
});

import { describe, expect, it } from 'vitest';
import { describeIdShape, describeNameShape, maskUserPath, redactLogText } from '../../src/util/redact.js';

describe('maskUserPath', () => {
  it('Windows Users 路径替换用户段', () => {
    expect(maskUserPath('C:\\Users\\Alice\\AppData\\Roaming\\Trae CN\\storage.json')).toBe(
      'C:\\Users\\<user>\\AppData\\Roaming\\Trae CN\\storage.json',
    );
  });
  it('Windows Documents and Settings 路径替换用户段', () => {
    expect(maskUserPath('C:\\Documents and Settings\\Bob\\AppData\\foo')).toBe(
      'C:\\Documents and Settings\\<user>\\AppData\\foo',
    );
  });
  it('macOS /Users 路径替换用户段', () => {
    expect(maskUserPath('/Users/Alice/Library/Application Support/Trae CN/storage.json')).toBe(
      '/Users/<user>/Library/Application Support/Trae CN/storage.json',
    );
  });
  it('Linux /home 路径替换用户段', () => {
    expect(maskUserPath('/home/bob/.accessmux/config.yaml')).toBe('/home/<user>/.accessmux/config.yaml');
  });
  it('非用户路径原样', () => {
    expect(maskUserPath('/var/lib/foo')).toBe('/var/lib/foo');
  });
});

describe('describeNameShape', () => {
  it('空字符串', () => {
    expect(describeNameShape('')).toBe('0 字符');
  });
  it('纯数字', () => {
    expect(describeNameShape('1234567890')).toBe('10 字符，纯数字');
  });
  it('含中文', () => {
    expect(describeNameShape('张三')).toBe('2 字符');
  });
});

describe('describeIdShape', () => {
  it('空值', () => {
    expect(describeIdShape('')).toBe('(空)');
  });
  it('纯数字 icube-dc id', () => {
    expect(describeIdShape('123456789012345')).toBe('15 位，纯数字');
  });
  it('32 字符 hex fallback', () => {
    expect(describeIdShape('a'.repeat(32))).toBe('32 位，含非数字');
  });
});