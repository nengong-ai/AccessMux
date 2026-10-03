// WorkBuddy 路径 / bundle id / Windows app name 解析（端口 spec §7.1）。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKBUDDY_AUTH_FILENAME,
  WORKBUDDY_BUNDLE_ID_CN,
  WORKBUDDY_BUNDLE_ID_GLOBAL,
  WORKBUDDY_WINDOWS_APP_NAME_CN,
  WORKBUDDY_WINDOWS_APP_NAME_GLOBAL,
  workBuddyAuthCandidates,
  workBuddyBundleId,
  workBuddyWindowsAppName,
} from '../../../src/adapters/workbuddy/paths.js';

describe('workBuddyAuthCandidates', () => {
  it('macOS 用 Library/Application Support/CodeBuddyExtension', () => {
    const candidates = workBuddyAuthCandidates('darwin', '/Users/test', {});
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.path).toBe(
      join('/Users/test', 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', WORKBUDDY_AUTH_FILENAME),
    );
  });

  it('Windows 用 %LOCALAPPDATA% / %APPDATA% / ~/AppData 多候选', () => {
    const candidates = workBuddyAuthCandidates('win32', 'C:/Users/test', {
      LOCALAPPDATA: 'C:/Users/test/AppData/Local',
      APPDATA: 'C:/Users/test/AppData/Roaming',
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const paths = candidates.map((c) => c.path);
    expect(paths.some((p) => p.includes('AppData/Local'))).toBe(true);
    expect(paths.some((p) => p.includes('AppData/Roaming'))).toBe(true);
  });

  it('Linux 用 $XDG_DATA_HOME 或 ~/.local/share', () => {
    const candidates = workBuddyAuthCandidates('linux', '/home/test', {});
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.path).toBe(join('/home/test', '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', WORKBUDDY_AUTH_FILENAME));
  });

  it('CN 排在前', () => {
    const candidates = workBuddyAuthCandidates('darwin', '/Users/test', {});
    expect(candidates[0]?.variant).toBe('cn');
  });

  it('所有 path 都以 workbuddy-desktop.info 结尾', () => {
    const candidates = workBuddyAuthCandidates('darwin', '/Users/test', {});
    expect(candidates.every((c) => c.path.endsWith(WORKBUDDY_AUTH_FILENAME))).toBe(true);
  });
});

describe('workBuddyBundleId / Windows app name', () => {
  it('CN 用 com.tencent.workbuddy.mac + WorkBuddy', () => {
    expect(workBuddyBundleId('cn')).toBe(WORKBUDDY_BUNDLE_ID_CN);
    expect(workBuddyWindowsAppName('cn')).toBe(WORKBUDDY_WINDOWS_APP_NAME_CN);
  });

  it('Global 用 com.workbuddy.workbuddy + WorkBuddy AI', () => {
    expect(workBuddyBundleId('global')).toBe(WORKBUDDY_BUNDLE_ID_GLOBAL);
    expect(workBuddyWindowsAppName('global')).toBe(WORKBUDDY_WINDOWS_APP_NAME_GLOBAL);
  });
});