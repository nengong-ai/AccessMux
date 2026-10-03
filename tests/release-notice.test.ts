import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const text = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('incorporated source redistribution notices', () => {
  it('ships complete MIT and Apache texts with original copyrights', () => {
    const wb = text('docs/third-party-licenses/dsh-workbuddy-connect-MIT.txt');
    const trae = text('docs/third-party-licenses/dsh-connect-trae-MIT.txt');
    const zcode = text('docs/third-party-licenses/ZCode-Apache-2.0.txt');
    expect(wb).toContain('Copyright (c) 2026 Corrine Hu');
    expect(trae).toContain('Copyright (c) 2026 LaoDing');
    for (const license of [wb, trae]) {
      expect(license).toContain('Permission is hereby granted, free of charge');
      expect(license).toContain('The above copyright notice and this permission notice');
      expect(license).toContain('OUT OF OR IN CONNECTION WITH THE SOFTWARE');
    }
    expect(zcode).toContain('Copyright 2026 Z.AI Co., Ltd');
    expect(zcode).toContain('END OF TERMS AND CONDITIONS');
    expect(zcode).toContain('APPENDIX: How to apply the Apache License');
    const oc = text('docs/third-party-licenses/opencode-MIT.txt');
    expect(oc).toContain('Copyright (c) 2025 opencode');
    expect(oc).toContain('Permission is hereby granted, free of charge');
    const notice = text('NOTICE');
    expect(notice).toContain('src/adapters/zcode/prefix.ts');
    expect(notice).toContain('4. opencode (sst/opencode)');
    expect(notice).toContain('no longer\n   used as an implementation basis');
  });

  it('includes notice/license entities and preserves Apache file modification comments', () => {
    const pkg = JSON.parse(text('package.json'));
    expect(pkg.files).toContain('NOTICE');
    expect(pkg.files).toContain('docs/third-party-licenses/*.txt');
    expect(pkg.scripts.prepack).not.toContain('--removeComments');
    expect(text('README.md')).toContain('[第三方声明](NOTICE)');
    for (const file of ['decrypt.ts', 'prefix.ts']) {
      const source = text(`src/adapters/zcode/${file}`);
      expect(source).toContain('Copyright 2026 Z.AI Co., Ltd');
      expect(source).toContain('Modified by AccessMux');
    }
  });
});
