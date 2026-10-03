// WorkBuddy chat body 准备（四轮返工对齐 dsh-workbuddy-connect/upstream.ts:
// 440-515 prepareChatBody + normalizeDeveloperRole + normalizeToolChoice）。
//
// 真实协议要点：
// - 上游拒绝非流式 → `stream: true` 强制
// - `role: "developer"` 会被 400（code 11128 "Illegal API invocation"）→ 改写为 system
// - `tool_choice` 上游只吃字符串形式 → OpenAI 对象形式扁平化
// - 其余字段透传：宿主传什么上游收什么，桥接层不吃参数

import { dropUnsupportedEffortForInternational } from './reasoning-fields.js';
import type { WorkBuddyVariant } from './variant.js';

export interface PrepareWorkBuddyChatBodyOptions {
  variant?: WorkBuddyVariant;
  /** 当前模型声明的 reasoning capability（从 catalog 推）。 */
  reasoningSupported: readonly string[];
  /** Adapter public path: reject unknown/unsupported input, including Global off. */
  strictReasoning?: boolean;
}

function normaliseReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  return lowered === '' ? undefined : lowered;
}

/** dsh upstream.ts:461-469：`role: "developer"` → `role: "system"`。 */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages'];
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
    const wrapped = message as Record<string, unknown>;
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system';
  }
}

/**
 * T010 终验实锤：上游对第三方 agent harness 的 system prompt 有指纹门
 * （400 code 11128 "Illegal API invocation from an unapproved channel"——
 * 命中 Claude Code 系模板句 "Main branch (you will usually use this for PRs)"
 * 即拦，一词之差即过，5/5 确定性；见 receipts/R010 终验章节）。
 *
 * 被剥离的是**宿主自己的工装提示词**（ZCode/DSH 等注入的行为约定）；
 * 用户对话内容在 user/assistant 消息里，原样保留。宿主注入的项目上下文
 * （AGENTS.md、git 状态等）实测走 user 角色（ZCode 的 <system-reminder>
 * 块即 user 消息），不触发门。此适配与"tools 不透传"同属明文档协议翻译，
 * 体验折损（agent 行为约定丢失）已写入 host-integration.md。
 *
 * 剥离后 messages 为空 → 抛错：不替用户编造提示词。
 */
function stripSystemPromptForFingerprintGate(obj: Record<string, unknown>): void {
  const messages = obj['messages'];
  if (!Array.isArray(messages)) return;
  const kept = messages.filter((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return true;
    return (message as Record<string, unknown>)['role'] !== 'system';
  });
  if (kept.length === 0 && messages.length > 0) {
    throw new Error('workbuddy route strips host system prompts (upstream fingerprint gate); no non-system messages left');
  }
  obj['messages'] = kept;
}

/** dsh upstream.ts:471-513：OpenAI tool_choice 拼写 → 上游字符串形式。 */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools'];
    delete obj['functions'];
  };
  if (!('tool_choice' in obj)) return;
  const choice: unknown = obj['tool_choice'];
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice'];
      suppress();
    }
    return;
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>;
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : '';
    if (type === 'none') {
      delete obj['tool_choice'];
      suppress();
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type;
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined;
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : '';
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name'];
      name = name.trim();
      obj['tool_choice'] = name !== '' ? name : 'auto';
    } else {
      delete obj['tool_choice'];
    }
    return;
  }
  delete obj['tool_choice'];
}

export function prepareWorkBuddyChatBody(source: string, options: PrepareWorkBuddyChatBodyOptions): string {
  const input = JSON.parse(source) as Record<string, unknown>;
  const body: Record<string, unknown> = { ...input };
  body['stream'] = true;
  normalizeDeveloperRole(body);
  stripSystemPromptForFingerprintGate(body);
  normalizeToolChoice(body);
  if (options.strictReasoning && input['reasoning_effort'] !== undefined &&
      (typeof input['reasoning_effort'] !== 'string' || !options.reasoningSupported.includes(input['reasoning_effort']))) {
    throw new Error('WorkBuddy model does not advertise requested reasoning effort');
  }
  const effort = normaliseReasoningEffort(input['reasoning_effort']);
  if (effort !== undefined) {
    const allowed = options.reasoningSupported;
    const isGlobal = options.variant === 'global';
    if (allowed.includes(effort)) {
      body['reasoning_effort'] = effort;
    } else if (effort === 'off' && !allowed.includes('off') && isGlobal) {
      // 端口 spec §2.2.6 #5：Global 端对 'off' 静默删除；CN 端抛错
      delete body['reasoning_effort'];
    } else if (allowed.length > 0 && !allowed.includes(effort)) {
      const requestedModel = typeof input['model'] === 'string' ? input['model'] : '';
      throw new Error(`WorkBuddy model ${requestedModel} does not advertise reasoning effort ${effort}`);
    }
  }
  const finalBody = options.variant === 'global'
    ? dropUnsupportedEffortForInternational(body, options.reasoningSupported as never)
    : body;
  return JSON.stringify(finalBody);
}
