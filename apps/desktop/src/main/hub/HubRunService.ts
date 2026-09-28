import type { ApprovalDecision, Connection, UserContent } from '@comitiva/contract';
import { RunEngine, type RunnerPort } from '../services/chat/RunEngine';
import type { TitleService } from '../services/TitleService';
import { HubChatStore, type HubChatStoreDeps } from './HubChatStore';

export interface HubRunServiceDeps extends Omit<HubChatStoreDeps, 'onStop'> {
  runner: RunnerPort;
  secretFor(connection: Connection): Promise<string | undefined>;
  title: Pick<TitleService, 'generate'>;
  workspacesDir: string;
  cancelGraceMs?: number;
}

/**
 * Turns in workspace conversations, run on this desktop with the member's
 * own connection and published to the hub (ADR 0017): the same RunEngine as
 * Personal conversations, over the hub's store. The window does not hear
 * from here: it gets the stream from the hub, like every other member.
 */
export class HubRunService {
  private readonly engine: RunEngine;
  readonly store: HubChatStore;

  constructor(private readonly deps: HubRunServiceDeps) {
    this.store = new HubChatStore({ ...deps, onStop: (id) => this.engine.cancel(id) });
    this.engine = new RunEngine({
      store: this.store,
      runner: deps.runner,
      secretFor: deps.secretFor,
      title: deps.title,
      workspacesDir: deps.workspacesDir,
      ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
      log: (m) => (deps.log ?? console.error)(`HubRunService: ${m}`),
    });
  }

  send(conversationId: string, content: UserContent): Promise<void> {
    return this.engine.send(conversationId, content);
  }

  retry(conversationId: string): Promise<void> {
    return this.engine.retry(conversationId);
  }

  /** Stops this desktop's run, or asks the hub to have the running desktop stop. */
  async cancel(conversationId: string): Promise<void> {
    if (this.engine.cancel(conversationId)) return;
    await this.deps.hub.call(() =>
      this.store.client().request('POST', `/api/v1/conversations/${conversationId}/cancel`),
    );
  }

  /** Only the desktop running the turn answers its approvals: they act on this machine. */
  decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): void {
    this.engine.decide(conversationId, toolUseId, decision);
  }

  forgetAgent(agentId: string): void {
    this.engine.forgetAgent(agentId);
    this.deps.local.forgetAgent(agentId);
  }

  shutdown(): void {
    this.engine.shutdown();
  }

  liveRunId(conversationId: string): string | undefined {
    return this.engine.liveRunId(conversationId);
  }
}
