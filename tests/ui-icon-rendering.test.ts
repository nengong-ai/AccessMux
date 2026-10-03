import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { wireLocalImages } from '../src/ui/public/app.js';
import { localAppIconFamily } from '../src/ui/public/brand-assets.js';

const css = readFileSync(new URL('../src/ui/public/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/ui/public/app.ts', import.meta.url), 'utf8');

class FakeImage {
  readonly dataset: Record<string, string>;
  hidden = false;
  readonly listeners = new Map<string, () => void>();
  constructor(readonly complete: boolean, readonly naturalWidth: number, readonly holder: FakeHolder, dataset: Record<string, string> = {}) { this.dataset = dataset; }
  addEventListener(type: string, handler: () => void): void { this.listeners.set(type, handler); }
  closest(selector: string): FakeHolder | null { return selector === '.app-icon, .source-icon' ? this.holder : null; }
}
class FakeHolder {
  innerHTML = '';
  readonly classes: string[] = [];
  readonly classList = { add: (name: string) => this.classes.push(name) };
}

describe('本机 App 图标渲染回退', () => {
  it('源状态重绘也绑定同一图片回退处理，并处理已缓存的 404 图片', () => {
    vi.stubGlobal('HTMLImageElement', FakeImage);
    try {
      const cachedHolder = new FakeHolder();
      const cachedBroken = new FakeImage(true, 0, cachedHolder);
      const root = { querySelectorAll: () => [cachedBroken] } as unknown as ParentNode;
      wireLocalImages(root);
      expect(cachedBroken.dataset.errorBound).toBe('true');
      expect(cachedBroken.hidden).toBe(true);
      expect(cachedHolder.classes).toContain('icon-empty');

      const fallbackHolder = new FakeHolder();
      const fallback = new FakeImage(false, 0, fallbackHolder, { iconFallback: '<svg viewBox=&quot;0 0 24 24&quot;></svg>' });
      wireLocalImages({ querySelectorAll: () => [fallback] } as unknown as ParentNode);
      fallback.listeners.get('error')?.();
      expect(fallbackHolder.innerHTML).toBe('<svg viewBox="0 0 24 24"></svg>');
      expect(fallback.hidden).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('宿主、源标题和签到共用同一 family 标识；WorkBuddy 只做 CSS 灰度石墨化', () => {
    for (const id of ['workbuddy', 'dsh', 'hermes', 'minimax-code', 'trae-cn', 'qoder']) expect(localAppIconFamily(id)).toBeTruthy();
    expect(app).toContain('wireLocalImages($(\'#source-status-list\'))');
    expect(app).toContain('iconFamilyClass(host.id)');
    expect(app).toContain('iconFamilyClass(adapter.id)');
    expect(app).toContain('iconFamilyClass(source.source)');
    expect(css).toContain('.brand-asset[src="/ui/app-icons/workbuddy.png"]');
    expect(css).toContain('filter: grayscale(1) brightness(.65) contrast(4)');
    expect(css).toContain('.source-icon.icon-empty,.app-icon.icon-empty');
    expect(css).toContain('display: none');
  });
});
