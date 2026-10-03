import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.js'],
    environment: 'node',
    // 只用注入替身或随机端口 loopback 合成服务，禁止真实模型请求。
  },
});
