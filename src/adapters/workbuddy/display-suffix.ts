// WorkBuddy 显示 id 装饰（端口 spec §2.2.5 + dsh-workbuddy-connect/
// adapter.ts:145-159）。
//
// WorkBuddy 实际目录里"display id == wire id"（端口 spec §2.2.3 注释），本文件
// 只为保留与 trae 同构的 display 装饰接口（让 T001 留出 catalog/UI 的扩展点）；
// 当前直接返回原 id。

export type DisplaySuffixFormatter = (id: string) => string;

export function displaySuffix(_id: string): string {
  return '';
}

export function withCatalogDisplay<T extends { id: string }>(
  model: T,
  _formatSuffix: DisplaySuffixFormatter = displaySuffix,
): T & { id: string } {
  return model;
}