import type {
  AgentLink,
  ApprovalDecision,
  HubEvent,
  HubRequest,
  PresenceMember,
  UserContent,
} from '@comitiva/contract';

/**
 * How the UI reaches the hub. On the desktop, main holds the token and the
 * socket and this goes over IPC (LocalBackend.hubTransport); in the web UI
 * (Phase 9) it will be fetch and a session cookie. Either way the same
 * RemoteBackend sits on top.
 */
export interface HubTransport {
  request<T = unknown>(
    method: HubRequest['method'],
    path: string,
    options?: { query?: Record<string, string>; body?: unknown },
  ): Promise<T>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  onEvent(handler: (channel: string, event: HubEvent) => void): () => void;
  onPresence(handler: (channel: string, members: PresenceMember[]) => void): () => void;
}

/**
 * What only a desktop does in a workspace (ADR 0017): run turns with the
 * member's own connection, keep how it runs each shared agent (links) and
 * the secret header values of workspace tool servers.
 */
export interface HubExecutor {
  send(conversationId: string, content: UserContent): Promise<void>;
  retry(conversationId: string): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  decide(conversationId: string, toolUseId: string, decision: ApprovalDecision): Promise<void>;
  links(workspaceId: string): Promise<AgentLink[]>;
  setLink(link: AgentLink): Promise<AgentLink>;
  secretNames(toolServerId: string, names: string[]): Promise<string[]>;
  setSecrets(toolServerId: string, headers: Record<string, string | null>): Promise<string[]>;
  /** Where the window loads a workspace attachment from (main fetches it with the token). */
  attachmentUrl(attachmentId: string): string;
}
