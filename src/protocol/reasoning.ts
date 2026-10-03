import type { ModelMetadata } from '../types.js';
import { workBuddyReasoningFields } from '../adapters/workbuddy/reasoning-fields.js';

/** Public request vocabulary; each model must also advertise the selected value. */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** Upstream reasoning alone does not establish a working bridge control. */
export function bridgeReasoningCapability(model: ModelMetadata, enabled?: boolean, adapterId?: string) {
  const reasoning = model.reasoning;
  // Keep original upstream metadata untouched; WorkBuddy excludes minimal and
  // allows off only with explicit canDisableThinking, using the same wire policy.
  const declared = adapterId === 'workbuddy' && reasoning
    ? workBuddyReasoningFields({ supports: reasoning.supported === true,
      supportedEfforts: reasoning.supportedEfforts, canDisableThinking: reasoning.canDisableThinking }).supported
    : reasoning?.supportedEfforts ?? [];
  const supportedEfforts = enabled === true && reasoning?.supported !== false
    ? [...new Set(declared.filter((effort): effort is ReasoningEffort =>
      (REASONING_EFFORTS as readonly string[]).includes(effort) &&
      (effort !== 'off' || reasoning?.canDisableThinking === true)))]
    : [];
  return {
    supported: supportedEfforts.length > 0,
    supportedEfforts,
    canDisableThinking: supportedEfforts.includes('off'),
  };
}
