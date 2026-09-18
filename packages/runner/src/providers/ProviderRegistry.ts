import { AppError, type ProviderId } from '@comitiva/contract';
import { AnthropicAdapter } from './api/AnthropicAdapter.js';
import { GoogleAdapter } from './api/GoogleAdapter.js';
import { OllamaAdapter } from './api/OllamaAdapter.js';
import { OpenAICompatibleAdapter } from './api/OpenAICompatibleAdapter.js';
import type { Capabilities, ProviderAdapter } from './ProviderAdapter.js';

/**
 * What the runner can execute. Form metadata (labels, key requirement, base
 * URL) is static data in `@comitiva/contract` (`providerDescriptors`).
 */
export interface RegisteredProvider {
  id: ProviderId;
  kind: ProviderAdapter['kind'];
  capabilities: Capabilities;
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new AppError('unknown_provider', `No adapter registered for provider "${id}"`);
    return adapter;
  }

  list(): RegisteredProvider[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      kind: a.kind,
      capabilities: a.capabilities,
    }));
  }
}

/** Every adapter the runner ships with. */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new AnthropicAdapter());
  registry.register(new OpenAICompatibleAdapter());
  registry.register(new GoogleAdapter());
  registry.register(new OllamaAdapter());
  return registry;
}
