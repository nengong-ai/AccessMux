// onboard 模块共用错误：message 说"哪里坏了"，hint 说"怎么办"（小白可读）。

export class OnboardError extends Error {
  /** 可操作的修复指引（引用 docs/onboard.md / host-integration.md 排错表） */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'OnboardError';
    this.hint = hint;
  }
}
