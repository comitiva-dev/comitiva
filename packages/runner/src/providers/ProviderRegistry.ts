import { AppError, type ProviderId } from '@comitiva/contract';
import type { Capabilities, ProviderAdapter } from './ProviderAdapter.js';

export interface ProviderDescriptor {
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

  list(): ProviderDescriptor[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      kind: a.kind,
      capabilities: a.capabilities,
    }));
  }
}
