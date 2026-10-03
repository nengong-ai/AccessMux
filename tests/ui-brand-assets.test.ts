import { describe, expect, it } from 'vitest';
import {
  accessMuxWordmark,
  appBrandIcon,
  appBrandFallbackIcon,
  localAppIconFamily,
  brandAssetAttributions,
  modelBrandIcon,
} from '../src/ui/public/brand-assets.js';

function expectSafeSvg(markup: string): void {
  expect(markup).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+"/);
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toMatch(/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/)|url\s*\(|<style\b/i);
}

describe('本地品牌资产', () => {
  it('输出保留 viewBox 的批准配色 AccessMux 字标', () => {
    const markup = accessMuxWordmark();
    expectSafeSvg(markup);
    expect(markup).toContain('#1D1D1F');
    expect(markup).toContain('#0066CC');
    expect(markup).not.toContain('#68e78e');
  });

  it('为 UI 支持的真实宿主和桥接源提供标识', () => {
    for (const id of ['zcode', 'opencode', 'qoder', 'trae-cn', 'trae-global', 'claude-code', 'codex']) {
      const markup = appBrandIcon(id);
      if (markup.startsWith('<img')) {
        expect(markup).toMatch(/^<img class="brand-asset" src="\/ui\/app-icons\/[a-z-]+\.png"/);
        expect(markup).not.toMatch(/\son[a-z]+\s*=|src="https?:/i);
        expectSafeSvg(appBrandFallbackIcon(id));
      } else {
        expectSafeSvg(markup);
        expect(markup).toContain('<path');
      }
    }
    expect(appBrandIcon('workbuddy')).toContain('src="/ui/app-icons/workbuddy.png"');
    for (const id of ['dsh', 'hermes', 'minimax-code']) expect(appBrandIcon(id)).toContain(`src="/ui/app-icons/${id}.png"`);
    for (const id of ['trae', 'trae-cn', 'trae-global', 'trae-solo-cn']) expect(localAppIconFamily(id)).toBe('trae');
    for (const id of ['qoder', 'qoder-cn', 'qoder-ide']) expect(localAppIconFamily(id)).toBe('qoder');
    for (const id of ['trae', 'trae-cn', 'trae-global', 'trae-solo-cn', 'qoder', 'qoder-cn', 'qoder-ide']) {
      expectSafeSvg(appBrandIcon(id));
      expect(appBrandIcon(id)).not.toContain('<img');
      expect(appBrandIcon(id)).toContain('viewBox="0 0 24 24"');
    }
    expect(appBrandIcon('qoder-cn')).toContain('<path');
    expect(appBrandIcon('unknown')).toBe('');
  });

  it('识别明确模型家族并保留匿名模型空值', () => {
    for (const id of [
      'glm-5.3', 'GLM/5.3', 'z.ai-1', 'zai:glm-5',
      'deepseek-v4', 'ds-r1', 'kimi-k2', 'moonshot-v1',
      'minimax-m2', 'abab-7', 'qwen3', 'qwq-32b',
      'hunyuan-t1', 'hy3', 'hy4-flash', 'gemini-2.5',
      'claude-sonnet-4', 'gpt-5', 'openai:o3', 'cursor-small', 'codex-mini',
      'trae-cn:glm-5.3', 'workbuddy:glm-5.3', 'workbuddy:deepseek-v4.1-flash', 'qoder:kimi-k2.5',
    ]) {
      const icon = modelBrandIcon(id);
      expectSafeSvg(icon);
      if (id.startsWith('workbuddy:')) expect(icon).toContain('<svg');
    }
    for (const id of ['workbuddy-model', 'anonymous-model', 'z-model', 'hy5', '']) {
      expect(modelBrandIcon(id)).toBe('');
    }
  });

  it('附带完整 MIT 文本、版本指纹及不背书声明', () => {
    expect(brandAssetAttributions.license).toContain('Copyright (c) 2023 LobeHub');
    expect(brandAssetAttributions.license).toContain('The above copyright notice and this permission notice');
    expect(brandAssetAttributions.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(brandAssetAttributions.blobShas.deepseek).toMatch(/^[a-f0-9]{40}$/);
    expect(brandAssetAttributions.notice).toContain('not ownership or trademark authorization');
    expect(brandAssetAttributions.nonAffiliation).toContain('does not imply affiliation');
    expect(brandAssetAttributions.workbuddy).toContain('CodeBuddy is not substituted');
  });
});
