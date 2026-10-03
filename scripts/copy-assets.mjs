// 把 src/ui/public 下非 .ts 资源（HTML/CSS）拷贝到 dist/ui/public。
// 由 npm run build 在 tsc 之后调用。
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('src/ui/public');
const dst = resolve('dist/ui/public');

if (!existsSync(src)) {
  console.error(`copy-assets: 找不到 ${src}`);
  process.exit(1);
}

cpSync(src, dst, {
  recursive: true,
  filter: (p) => !p.endsWith('.ts'),
});
console.log(`copy-assets: ${src} -> ${dst}`);