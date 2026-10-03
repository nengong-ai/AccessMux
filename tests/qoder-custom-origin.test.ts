import { describe, expect, it } from 'vitest';
import { parseQoderSettings } from '../src/adapters/qoder/catalog-metadata.js';
import { modelsFromIds } from '../src/adapters/qoder/catalog.js';

describe('Qoder directory custom provider provenance', () => {
  it('uses actual settings rows even without a contextWindow and never copies credentials', () => {
    const metadata = parseQoderSettings({ providers: {
      'opencode-go': {
        apiKey: 'SYNTHETIC-NOT-PUBLIC', headers: { authorization: 'SYNTHETIC-NOT-PUBLIC' },
        models: [{ id: 'qwen3.8-max' }, { model: 'qwen3.8-flash', contextWindow: 120_000 }],
      },
    } }, {}, '2026-10-03T00:00:00Z');
    const models = modelsFromIds(['opencode-go/qwen3.8-max', 'opencode-go/qwen3.8-flash'], metadata);
    for (const model of models) {
      expect(model.tags).toContain('custom-provider');
      expect(model.callVerified).toBe(false);
      expect(model.free).toBeUndefined();
      expect(model).not.toHaveProperty('customProvider');
    }
    expect(models[1]?.minCtx).toMatchObject({ value: 120_000 });
    expect(JSON.stringify({ metadata, models })).not.toContain('SYNTHETIC-NOT-PUBLIC');
  });
  it('does not infer custom provenance from a slash or model name alone', () => {
    expect(modelsFromIds(['opencode-go/qwen3.8-max'])[0]?.tags).not.toContain('custom-provider');
    expect(modelsFromIds(['Qwen3.8-Flash'])[0]?.callVerified).toBe(true);
  });
});
