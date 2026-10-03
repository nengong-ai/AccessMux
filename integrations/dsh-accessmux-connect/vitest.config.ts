import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.js'],
    environment: 'node',
    // 测试不得触网：目录拉取一律注入 fetchImpl 替身。
  },
});
