import type { Agent, ValidAgentDraft, ValidAgentPatch } from '@comitiva/contract';
import type { AgentRepository } from '../db/repositories/AgentRepository';

/**
 * Agents as the UI manages them. Validation (connection usable, model known)
 * lives in AgentRepository, inside the write transaction. Conversations join
 * in Phase 4.
 */
export class AgentService {
  constructor(private readonly repo: AgentRepository) {}

  list(): Agent[] {
    return this.repo.list();
  }

  create(draft: ValidAgentDraft): Agent {
    return this.repo.create(draft);
  }

  update(id: string, patch: ValidAgentPatch): Agent {
    return this.repo.update(id, patch);
  }

  delete(id: string): void {
    this.repo.delete(id);
  }

  /** `name` comes localized from the UI; the fallback is English. */
  duplicate(id: string, name?: string): Agent {
    return this.repo.duplicate(id, name ?? `${this.repo.require(id).name} (copy)`);
  }
}
