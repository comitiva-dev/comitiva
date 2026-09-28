import {
  AgentDraft,
  AgentPatch,
  type Agent,
  type AgentLink,
  type ApprovalDecision,
  type AttachmentBlock,
  type AttachmentInput,
  type Conversation,
  type ConversationListInput,
  type ConversationStatus,
  type HubConversationSummary,
  type HubEvent,
  type MessagePage,
  type SearchInput,
  type SearchResult,
  type SharedAgent,
  type ToolServer,
  type ToolServerDraft,
  type ToolServerPatch,
  type ToolServerSpec,
  type ToolServerTestTarget,
  type ToolServerValueInput,
  type UsageBucket,
  type UsageRange,
  type UsageSummary,
  type UsageTotals,
  type UserContent,
  type WorkspaceHeaderValue,
  type WorkspaceToolServer,
} from '@comitiva/contract';
import {
  BackendError,
  type Backend,
  type BackendEvent,
  type ConversationListItem,
  type WorkspaceContext,
} from './Backend';
import type { HubExecutor, HubTransport } from './hub/HubTransport';

export interface RemoteBackendOptions {
  /** Personal backend: what stays on this machine (connections, dialogs, updates…). */
  local: Backend;
  transport: HubTransport;
  executor: HubExecutor;
  workspace: WorkspaceContext;
}

const RUNNING: ReadonlySet<ConversationStatus> = new Set(['running', 'awaiting-approval']);

/**
 * A hub workspace behind the Backend interface (ADR 0017). Shared data comes
 * from the hub; turns run on this desktop through the executor (main), and
 * their stream comes back from the hub like everyone else's; what only
 * exists on this machine is the local backend's.
 *
 * A shared agent appears as a regular Agent: its connection, folders and
 * local tool servers are this member's link, kept on this machine. Editing
 * it splits the change between the hub (shared fields) and the link.
 */
export class RemoteBackend implements Backend {
  private readonly ws: string;
  private readonly local: Backend;
  private readonly transport: HubTransport;
  private readonly executor: HubExecutor;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private readonly channels = new Set<string>();
  private readonly statuses = new Map<string, ConversationStatus>();
  private readonly workspaceServerIds = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private changedTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly opts: RemoteBackendOptions) {
    this.ws = opts.workspace.id;
    this.local = opts.local;
    this.transport = opts.transport;
    this.executor = opts.executor;
    this.offs.push(
      this.transport.onEvent((channel, event) => this.dispatch(channel, event)),
      this.transport.onPresence((channel, members) => {
        if (channel === this.presenceChannel) this.emit({ type: 'presence.updated', members });
      }),
      this.local.onEvent((event) => {
        // Only what is not about Personal data passes through.
        if (
          ['runner.status', 'updates.status', 'menu.command', 'hub.status'].includes(event.type)
        ) {
          this.emit(event);
        }
      }),
    );
    this.listen(this.presenceChannel);
  }

  /** Stops listening (switching workspaces). */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.changedTimer);
    this.offs.forEach((off) => off());
    for (const channel of this.channels) void this.transport.unsubscribe(channel).catch(() => {});
    this.channels.clear();
  }

  workspace(): WorkspaceContext {
    return this.opts.workspace;
  }

  get app() {
    return this.local.app;
  }
  get runner() {
    return this.local.runner;
  }
  get secrets() {
    return this.local.secrets;
  }
  get hub() {
    return this.local.hub;
  }
  get connections() {
    return this.local.connections;
  }
  get settings() {
    return this.local.settings;
  }
  get dialogs() {
    return this.local.dialogs;
  }
  get googleDrive() {
    return this.local.googleDrive;
  }
  get updates() {
    return this.local.updates;
  }
  get bundle() {
    return this.local.bundle;
  }

  // ------------------------------------------------------------------ agents

  agents = {
    list: async (): Promise<Agent[]> => {
      const [shared, links] = await Promise.all([
        this.get<SharedAgent[]>(`/api/v1/workspaces/${this.ws}/agents`),
        this.executor.links(this.ws),
      ]);
      const byAgent = new Map(links.map((l) => [l.agentId, l]));
      return shared.map((a) => toAgent(a, byAgent.get(a.id) ?? null));
    },

    create: async (draft: AgentDraft): Promise<Agent> => {
      const valid = AgentDraft.parse(draft);
      const provider = await this.providerOf(valid.connectionId);
      const { shared: sharedTools, local: localTools } = await this.splitTools(valid.toolServerIds);
      const created = await this.transport.request<SharedAgent>(
        'POST',
        `/api/v1/workspaces/${this.ws}/agents`,
        {
          body: {
            name: valid.name,
            avatar: valid.avatar,
            provider,
            model: valid.model,
            role: valid.role,
            params: valid.params,
            toolServerIds: sharedTools,
            permissionPolicy: valid.permissionPolicy,
            tags: valid.tags,
          },
        },
      );
      const link = await this.executor.setLink({
        agentId: created.id,
        workspaceId: this.ws,
        connectionId: valid.connectionId,
        roots: valid.roots,
        toolServerIds: localTools,
      });
      return toAgent(created, link);
    },

    update: async (id: string, patch: AgentPatch): Promise<Agent> => {
      const valid = AgentPatch.parse(patch);
      let shared = await this.get<SharedAgent>(`/api/v1/agents/${id}`);
      const links = await this.executor.links(this.ws);
      let link = links.find((l) => l.agentId === id) ?? null;

      const body: Record<string, unknown> = {};
      for (const key of [
        'name',
        'avatar',
        'model',
        'role',
        'params',
        'permissionPolicy',
        'tags',
      ] as const) {
        if (valid[key] !== undefined) body[key] = valid[key];
      }
      let localTools = link?.toolServerIds ?? [];
      if (valid.toolServerIds !== undefined) {
        const split = await this.splitTools(valid.toolServerIds);
        body.toolServerIds = split.shared;
        localTools = split.local;
      }
      if (Object.keys(body).length > 0) {
        shared = await this.transport.request<SharedAgent>('PATCH', `/api/v1/agents/${id}`, {
          body,
        });
      }
      if (
        valid.connectionId !== undefined ||
        valid.roots !== undefined ||
        valid.toolServerIds !== undefined
      ) {
        link = await this.executor.setLink({
          agentId: id,
          workspaceId: this.ws,
          connectionId: valid.connectionId ?? link?.connectionId ?? null,
          roots: valid.roots ?? link?.roots ?? [],
          toolServerIds: localTools,
        });
      }
      return toAgent(shared, link);
    },

    delete: (id: string) => this.transport.request<void>('DELETE', `/api/v1/agents/${id}`),

    duplicate: async (id: string, name?: string): Promise<Agent> => {
      const [shared, links] = await Promise.all([
        this.get<SharedAgent>(`/api/v1/agents/${id}`),
        this.executor.links(this.ws),
      ]);
      const link = links.find((l) => l.agentId === id) ?? null;
      const copy = await this.transport.request<SharedAgent>(
        'POST',
        `/api/v1/workspaces/${this.ws}/agents`,
        {
          body: {
            name: name ?? `${shared.name} (copy)`,
            avatar: shared.avatar,
            provider: shared.provider,
            model: shared.model,
            role: shared.role,
            params: shared.params,
            toolServerIds: shared.toolServerIds,
            permissionPolicy: shared.permissionPolicy,
            tags: shared.tags,
          },
        },
      );
      const copyLink = link ? await this.executor.setLink({ ...link, agentId: copy.id }) : null;
      return toAgent(copy, copyLink);
    },
  };

  // ----------------------------------------------------------- conversations

  conversations = {
    list: async (filter?: ConversationListInput): Promise<ConversationListItem[]> => {
      const query: Record<string, string> = { archived: String(filter?.archived ?? false) };
      if (filter?.agentId) query.agentId = filter.agentId;
      const rows = await this.transport.request<HubConversationSummary[]>(
        'GET',
        `/api/v1/workspaces/${this.ws}/conversations`,
        { query },
      );
      for (const r of rows) this.statuses.set(r.conversation.id, r.conversation.status);
      return rows.map((r) => ({
        conversation: r.conversation,
        unread: r.unread,
        pendingApproval: r.pendingApproval,
        runner: r.runner,
      }));
    },
    create: (agentId: string) =>
      this.transport.request<Conversation>('POST', `/api/v1/workspaces/${this.ws}/conversations`, {
        body: { agentId },
      }),
    rename: (id: string, title: string) =>
      this.transport.request<Conversation>('PATCH', `/api/v1/conversations/${id}`, {
        body: { title },
      }),
    archive: (id: string, archived: boolean) =>
      this.transport.request<Conversation>('PATCH', `/api/v1/conversations/${id}`, {
        body: { archived },
      }),
    markRead: (id: string) =>
      this.transport.request<void>('POST', `/api/v1/conversations/${id}/read`),
    exportMarkdown: async (): Promise<string | null> => {
      throw new BackendError(
        'not_implemented',
        'Exporting workspace conversations comes later',
        false,
      );
    },
  };

  // ---------------------------------------------------------------- messages

  messages = {
    /** Listens to the conversation before reading the page, so no event falls in between. */
    list: async (
      conversationId: string,
      opts: { beforeSeq?: number; limit?: number } = {},
    ): Promise<MessagePage> => {
      await this.listen(`private-conversation.${conversationId}`);
      const query: Record<string, string> = {};
      if (opts.beforeSeq !== undefined) query.beforeSeq = String(opts.beforeSeq);
      if (opts.limit !== undefined) query.limit = String(opts.limit);
      return this.transport.request<MessagePage>(
        'GET',
        `/api/v1/conversations/${conversationId}/messages`,
        { query },
      );
    },
    send: (conversationId: string, content: UserContent) =>
      this.executor.send(conversationId, content),
    cancel: (conversationId: string) => this.executor.cancel(conversationId),
    retry: (conversationId: string) => this.executor.retry(conversationId),
  };

  approvals = {
    decide: (conversationId: string, toolUseId: string, decision: ApprovalDecision) =>
      this.executor.decide(conversationId, toolUseId, decision),
  };

  search = {
    query: (input: SearchInput) =>
      this.transport.request<SearchResult>('GET', `/api/v1/workspaces/${this.ws}/search`, {
        query: { query: input.query, limit: String(input.limit ?? 20) },
      }),
  };

  attachments = {
    add: (input: AttachmentInput) =>
      this.transport.request<AttachmentBlock>('POST', `/api/v1/workspaces/${this.ws}/attachments`, {
        body: input,
      }),
    url: (path: string) => this.executor.attachmentUrl(path),
  };

  // ------------------------------------------------------------ tool servers

  toolServers = {
    /** This machine's servers (for members' own links) and the workspace's. */
    list: async (): Promise<ToolServer[]> => {
      const [local, shared] = await Promise.all([
        this.local.toolServers.list(),
        this.workspaceServers(),
      ]);
      return [...local, ...shared.map(toToolServer)];
    },
    /** http servers become the workspace's when an admin adds them; others stay on this machine. */
    create: async (draft: ToolServerDraft): Promise<ToolServer> => {
      if (draft.spec.transport !== 'http' || !this.isAdmin())
        return this.local.toolServers.create(draft);
      const created = await this.transport.request<WorkspaceToolServer>(
        'POST',
        `/api/v1/workspaces/${this.ws}/tool-servers`,
        {
          body: {
            name: draft.name,
            url: draft.spec.url,
            headers: sharedHeaders(draft.spec),
            enabled: draft.enabled ?? true,
          },
        },
      );
      this.workspaceServerIds.add(created.id);
      await this.saveSecrets(created.id, draft.spec);
      return toToolServer(created);
    },
    update: async (id: string, patch: ToolServerPatch): Promise<ToolServer> => {
      if (this.toolServers.scope(id) === 'local') return this.local.toolServers.update(id, patch);
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.enabled !== undefined) body.enabled = patch.enabled;
      if (patch.spec?.transport === 'http') {
        body.url = patch.spec.url;
        body.headers = sharedHeaders(patch.spec);
      }
      const updated = await this.transport.request<WorkspaceToolServer>(
        'PATCH',
        `/api/v1/tool-servers/${id}`,
        {
          body,
        },
      );
      if (patch.spec) await this.saveSecrets(id, patch.spec);
      return toToolServer(updated);
    },
    delete: async (id: string): Promise<void> => {
      if (this.toolServers.scope(id) === 'local') return this.local.toolServers.delete(id);
      await this.transport.request<void>('DELETE', `/api/v1/tool-servers/${id}`);
      this.workspaceServerIds.delete(id);
    },
    test: async (target: ToolServerTestTarget) => {
      if ('spec' in target) {
        // Unsaved settings run here; secrets kept for a workspace server are this member's.
        const { id: _id, ...rest } = target as { spec: ToolServerSpec; id?: string };
        return this.local.toolServers.test(
          target.id && this.toolServers.scope(target.id) === 'local' ? target : rest,
        );
      }
      if (this.toolServers.scope(target.id) === 'local') return this.local.toolServers.test(target);
      throw new BackendError('not_implemented', 'Test a workspace server from its form', false);
    },
    scope: (id: string): 'local' | 'workspace' =>
      this.workspaceServerIds.has(id) ? 'workspace' : 'local',
  };

  // ------------------------------------------------------------------ usage

  usage = {
    summary: (range: UsageRange) =>
      this.transport.request<UsageSummary>('GET', `/api/v1/workspaces/${this.ws}/usage/summary`, {
        query: rangeQuery(range),
      }),
    timeseries: (range: UsageRange) =>
      this.transport.request<UsageBucket[]>(
        'GET',
        `/api/v1/workspaces/${this.ws}/usage/timeseries`,
        {
          query: rangeQuery(range),
        },
      ),
    conversation: (conversationId: string) =>
      this.transport.request<UsageTotals>('GET', `/api/v1/conversations/${conversationId}/usage`),
    export: async (): Promise<string | null> => {
      throw new BackendError('not_implemented', 'Exporting workspace usage comes later', false);
    },
    prices: () => this.local.usage.prices(),
    setPrice: (...args: Parameters<Backend['usage']['setPrice']>) =>
      this.local.usage.setPrice(...args),
    clearPrice: (...args: Parameters<Backend['usage']['clearPrice']>) =>
      this.local.usage.clearPrice(...args),
  };

  onEvent(handler: (event: BackendEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  // --------------------------------------------------------------- internals

  private get presenceChannel(): string {
    return `presence-workspace.${this.ws}`;
  }

  private isAdmin(): boolean {
    return this.opts.workspace.role === 'owner' || this.opts.workspace.role === 'admin';
  }

  private async listen(channel: string): Promise<void> {
    if (this.channels.has(channel) || this.disposed) return;
    this.channels.add(channel);
    try {
      await this.transport.subscribe(channel);
    } catch (err) {
      this.channels.delete(channel);
      throw err;
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.transport.request<T>('GET', path);
  }

  private async workspaceServers(): Promise<WorkspaceToolServer[]> {
    const servers = await this.get<WorkspaceToolServer[]>(
      `/api/v1/workspaces/${this.ws}/tool-servers`,
    );
    this.workspaceServerIds.clear();
    for (const s of servers) this.workspaceServerIds.add(s.id);
    return servers;
  }

  /** Workspace server ids go to the shared agent; the others (this machine's) to the link. */
  private async splitTools(ids: string[]): Promise<{ shared: string[]; local: string[] }> {
    const known = new Set((await this.workspaceServers()).map((s) => s.id));
    return { shared: ids.filter((id) => known.has(id)), local: ids.filter((id) => !known.has(id)) };
  }

  private async providerOf(connectionId: string) {
    const found = (await this.local.connections.list()).find(
      (c) => c.connection.id === connectionId,
    );
    if (!found) throw new BackendError('not_found', 'That connection does not exist here', false);
    return found.connection.provider;
  }

  /** A header typed as a secret is kept on this machine; `keepSecret` keeps it; the rest are dropped. */
  private async saveSecrets(id: string, spec: ToolServerSpec): Promise<void> {
    if (spec.transport !== 'http') return;
    const headers: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      if ('secret' in value) headers[name] = value.secret;
      else if ('value' in value) headers[name] = null;
    }
    if (Object.keys(headers).length > 0) await this.executor.setSecrets(id, headers);
  }

  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Reloads of shared data other members changed, coalesced. */
  private changed(what: 'agents' | 'conversations' | 'toolServers' | 'members'): void {
    this.emit({ type: 'workspace.changed', what });
  }

  private conversationsChangedSoon(): void {
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => this.changed('conversations'), 300);
  }

  private dispatch(channel: string, event: HubEvent): void {
    if (this.disposed || !this.channels.has(channel)) return;
    switch (event.type) {
      case 'message.created':
      case 'message.updated':
        this.emit({ type: 'message.updated', message: event.message, rev: event.rev });
        return;
      case 'run.text_delta':
        this.emit({
          type: 'message.delta',
          conversationId: event.conversationId,
          messageId: event.messageId,
          rev: event.rev,
          text: event.text,
        });
        return;
      case 'run.block':
        this.emit({
          type: 'message.block',
          conversationId: event.conversationId,
          messageId: event.messageId,
          rev: event.rev,
          block: event.block,
        });
        return;
      case 'run.tool_result':
        this.emit({
          type: 'message.block',
          conversationId: event.conversationId,
          messageId: event.messageId,
          rev: event.rev,
          block: {
            type: 'tool_result',
            toolUseId: event.toolUseId,
            content: event.output,
            isError: event.isError,
            durationMs: event.durationMs,
          },
        });
        return;
      case 'conversation.created':
      case 'conversation.updated': {
        const { conversation } = event;
        const before = this.statuses.get(conversation.id);
        this.statuses.set(conversation.id, conversation.status);
        this.emit({
          type: 'conversation.updated',
          conversation,
          pendingApproval: event.pendingApproval,
          runner: event.runner,
        });
        // A reply finished in a conversation not open here: its unread count changed.
        const open = this.channels.has(`private-conversation.${conversation.id}`);
        if (before && RUNNING.has(before) && !RUNNING.has(conversation.status) && !open) {
          this.conversationsChangedSoon();
        }
        return;
      }
      case 'agent.created':
      case 'agent.updated':
      case 'agent.deleted':
        this.changed('agents');
        return;
      case 'tool_server.created':
      case 'tool_server.updated':
      case 'tool_server.deleted':
        this.changed('toolServers');
        return;
      case 'member.added':
      case 'member.updated':
      case 'member.removed':
        this.changed('members');
        return;
      default:
        return;
    }
  }
}

/** A shared agent as the UI's Agent: the connection, folders and local tools are this member's link. */
export function toAgent(shared: SharedAgent, link: AgentLink | null): Agent {
  return {
    id: shared.id,
    name: shared.name,
    avatar: shared.avatar,
    // No link yet: no connection, and the UI asks this member to choose one.
    connectionId: link?.connectionId ?? '',
    model: shared.model,
    role: shared.role,
    params: shared.params,
    toolServerIds: [...shared.toolServerIds, ...(link?.toolServerIds ?? [])],
    roots: link?.roots ?? [],
    permissionPolicy: shared.permissionPolicy,
    fallbackConnectionIds: [],
    tags: shared.tags,
    createdAt: shared.createdAt,
    updatedAt: shared.updatedAt,
  };
}

/** A workspace server as the UI's ToolServer (secret headers show as secrets, never values). */
export function toToolServer(server: WorkspaceToolServer): ToolServer {
  return {
    id: server.id,
    name: server.name,
    transport: 'http',
    command: null,
    args: [],
    env: {},
    url: server.url,
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([name, v]) => [
        name,
        'value' in v
          ? { value: v.value }
          : { secretRef: `hubToolServer:${server.id}:header:${name}` },
      ]),
    ),
    builtin: false,
    enabled: server.enabled,
    createdAt: server.createdAt,
  };
}

/** Headers as the hub keeps them: plain values, and secrets as `{ secretRef: 'member' }`. */
function sharedHeaders(
  spec: Extract<ToolServerSpec, { transport: 'http' }>,
): Record<string, WorkspaceHeaderValue> {
  return Object.fromEntries(
    Object.entries(spec.headers ?? {}).map(([name, value]: [string, ToolServerValueInput]) => [
      name,
      'value' in value ? { value: value.value } : { secretRef: 'member' as const },
    ]),
  );
}

function rangeQuery(range: UsageRange): Record<string, string> {
  return {
    from: range.from,
    to: range.to,
    tzOffsetMinutes: String(range.tzOffsetMinutes ?? 0),
  };
}
