// Adapter 注册表：每个桥接源独立注册，单源失效不影响其他源（D8）。

import type { ProviderAdapter } from './types.js';

const adapters = new Map<string, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`adapter 已注册: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): ProviderAdapter[] {
  return [...adapters.values()];
}

/** 仅供测试重置 */
export function clearRegistry(): void {
  adapters.clear();
}
