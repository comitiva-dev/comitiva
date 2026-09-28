import { ulid } from 'ulid';
import {
  appendText,
  HubRunEventsInput,
  HubRunFinishInput,
  HubRunStartInput,
  type Block,
  type Conversation,
  type HubEvent,
  type HubRunner,
  type Message,
  type SharedAgent,
  type Workspace,
  type WorkspaceRole,
} from '@comitiva/contract';

/**
 * An in-process stand-in for the Laravel hub (comitiva-dev/hub), for unit
 * and integration tests (ADR 0015): the REST endpoints desktops use, with
 * the hub's rules that matter to them (run lock, event batches numbered by
 * the conversation's `rev`, finish), and a Pusher-protocol server the real
 * PusherSocket connects to through `WebSocketImpl`. The real hub is covered
 * by its own suite and by the e2e against its image.
 */

interface User {
  id: string;
  name: string;
  email: string;
  password: string;
}
interface Run {
  id: string;
  conversationId: string;
  replyId: string;
  userId: string;
  token: string;
  lastBatch: number;
  active: boolean;
}
interface ConversationRow extends Conversation {
  workspaceId: string;
  rev: number;
  pending: unknown;
  titleSource: 'placeholder' | 'auto' | 'user' | null;
}

const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class FakeHub {
  readonly url = 'http://fake-hub.test';
  readonly key = 'fake-key';
  private readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, string>(); // token → user id
  private readonly workspaces = new Map<string, { id: string; name: string; createdAt: string }>();
  private readonly members = new Map<string, Map<string, WorkspaceRole>>(); // ws → user → role
  private readonly invitations = new Map<
    string,
    { workspaceId: string; email: string; role: WorkspaceRole }
  >();
  readonly agents = new Map<string, SharedAgent>();
  readonly conversations = new Map<string, ConversationRow>();
  readonly messages = new Map<string, Message[]>();
  readonly runs = new Map<string, Run>();
  private readonly sockets = new Set<FakeSocket>();
  /** Every request, for assertions (method and path). */
  readonly requests: string[] = [];

  /** `fetch` for HubClient. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push(`${method} ${url.pathname}`);
    const auth = new Headers(init?.headers).get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    try {
      const result = this.route(method, url, body, token);
      if (result === undefined) return new Response(null, { status: 204 });
      const [status, payload] =
        Array.isArray(result) && result.length === 2 && typeof result[0] === 'number'
          ? (result as [number, unknown])
          : [200, result];
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(
          JSON.stringify({ error: { code: err.code, message: err.message, retryable: false } }),
          { status: err.status, headers: { 'content-type': 'application/json' } },
        );
      }
      throw err;
    }
  };

  /** `WebSocket` for PusherSocket: connects to this hub's Pusher-protocol server. */
  readonly WebSocket = ((hub: FakeHub) =>
    class extends FakeSocket {
      constructor(url: string) {
        super(hub, url);
      }
    })(this) as unknown as typeof globalThis.WebSocket;

  // ----------------------------------------------------------------- routing

  private route(
    method: string,
    url: URL,
    body: Record<string, unknown>,
    token: string | null,
  ): unknown {
    const path = url.pathname;
    const m = (pattern: RegExp) => pattern.exec(`${method} ${path}`);
    let r: RegExpExecArray | null;

    if (m(/^GET \/api\/v1\/meta$/)) {
      return {
        apiVersion: 1,
        edition: 'community',
        contractVersion: 'contract-v0.2.0',
        capabilities: { execution: false, registration: 'open' },
        realtime: { key: this.key, host: 'fake-hub.test', port: 443, scheme: 'https' },
      };
    }
    if (m(/^POST \/api\/v1\/auth\/register$/)) {
      const email = String(body.email).toLowerCase();
      if ([...this.users.values()].some((u) => u.email === email)) {
        throw new HttpError(409, 'email_taken', 'taken');
      }
      const user: User = {
        id: ulid(),
        name: String(body.name),
        email,
        password: String(body.password),
      };
      this.users.set(user.id, user);
      if (typeof body.invitationToken === 'string') this.accept(body.invitationToken, user);
      return [201, { token: this.issue(user), user: this.publicUser(user) }];
    }
    if (m(/^POST \/api\/v1\/auth\/login$/)) {
      const user = [...this.users.values()].find(
        (u) => u.email === String(body.email).toLowerCase() && u.password === body.password,
      );
      if (!user) throw new HttpError(401, 'invalid_credentials', 'wrong');
      return { token: this.issue(user), user: this.publicUser(user) };
    }

    const user = token ? this.users.get(this.tokens.get(token) ?? '') : undefined;
    if (!user) throw new HttpError(401, 'hub_auth_required', 'Sign in');

    if (m(/^POST \/api\/v1\/auth\/logout$/)) {
      this.tokens.delete(token!);
      return undefined;
    }
    if (m(/^GET \/api\/v1\/me$/)) return this.publicUser(user);
    if (m(/^POST \/broadcasting\/auth$/)) {
      const channel = String(body.channel_name);
      if (!this.mayListen(user, channel)) throw new HttpError(403, 'forbidden', 'no');
      const channelData = channel.startsWith('presence-')
        ? JSON.stringify({ user_id: user.id, user_info: { id: user.id, name: user.name } })
        : undefined;
      return {
        auth: `${this.key}:${body.socket_id}:${channel}`,
        ...(channelData ? { channel_data: channelData } : {}),
      };
    }
    if (m(/^GET \/api\/v1\/workspaces$/)) {
      return [...this.members.entries()]
        .filter(([, roles]) => roles.has(user.id))
        .map(([id, roles]) => this.workspace(id, roles.get(user.id)!));
    }
    if (m(/^POST \/api\/v1\/workspaces$/)) {
      const id = ulid();
      this.workspaces.set(id, { id, name: String(body.name), createdAt: now() });
      this.members.set(id, new Map([[user.id, 'owner']]));
      return [201, this.workspace(id, 'owner')];
    }
    if ((r = m(/^POST \/api\/v1\/workspaces\/(\w+)\/invitations$/))) {
      this.role(user, r[1]!);
      const token = `tok${ulid()}`;
      this.invitations.set(token, {
        workspaceId: r[1]!,
        email: String(body.email).toLowerCase(),
        role: (body.role as WorkspaceRole) ?? 'member',
      });
      return [201, { id: ulid(), token, url: `${this.url}/invite/${token}`, expiresAt: now() }];
    }
    if ((r = m(/^POST \/api\/v1\/invitations\/(\w+)\/accept$/))) {
      const ws = this.accept(r[1]!, user);
      return this.workspace(ws, this.members.get(ws)!.get(user.id)!);
    }
    if ((r = m(/^GET \/api\/v1\/workspaces\/(\w+)\/agents$/))) {
      this.role(user, r[1]!);
      return [...this.agents.values()].filter((a) => a.workspaceId === r![1]);
    }
    if ((r = m(/^POST \/api\/v1\/workspaces\/(\w+)\/agents$/))) {
      this.role(user, r[1]!);
      const agent: SharedAgent = {
        id: ulid(),
        workspaceId: r[1]!,
        name: String(body.name),
        avatar: body.avatar as SharedAgent['avatar'],
        provider: body.provider as SharedAgent['provider'],
        model: (body.model as string | null) ?? null,
        role: (body.role as string) ?? '',
        params: (body.params as SharedAgent['params']) ?? {},
        toolServerIds: (body.toolServerIds as string[]) ?? [],
        permissionPolicy: (body.permissionPolicy as SharedAgent['permissionPolicy']) ?? 'ask',
        tags: (body.tags as string[]) ?? [],
        createdBy: user.id,
        createdAt: now(),
        updatedAt: now(),
      };
      this.agents.set(agent.id, agent);
      this.broadcast(`presence-workspace.${agent.workspaceId}`, { type: 'agent.created', agent });
      return [201, agent];
    }
    if ((r = m(/^(GET|PATCH) \/api\/v1\/agents\/(\w+)$/))) {
      const agent = this.agents.get(r[2]!);
      if (!agent) throw new HttpError(404, 'not_found', 'agent');
      this.role(user, agent.workspaceId);
      if (r[1] === 'PATCH') {
        Object.assign(agent, body, { updatedAt: now() });
        this.broadcast(`presence-workspace.${agent.workspaceId}`, { type: 'agent.updated', agent });
      }
      return agent;
    }
    if ((r = m(/^GET \/api\/v1\/workspaces\/(\w+)\/tool-servers$/))) {
      this.role(user, r[1]!);
      return [];
    }
    if ((r = m(/^GET \/api\/v1\/workspaces\/(\w+)\/conversations$/))) {
      this.role(user, r[1]!);
      return [...this.conversations.values()]
        .filter(
          (c) =>
            c.workspaceId === r![1] && c.archived === (url.searchParams.get('archived') === 'true'),
        )
        .map((c) => this.summary(c));
    }
    if ((r = m(/^POST \/api\/v1\/workspaces\/(\w+)\/conversations$/))) {
      this.role(user, r[1]!);
      const c: ConversationRow = {
        id: ulid(),
        agentId: String(body.agentId),
        title: null,
        status: 'idle',
        harnessSessionId: null,
        archived: false,
        lastActivityAt: now(),
        createdAt: now(),
        workspaceId: r[1]!,
        rev: 0,
        pending: null,
        titleSource: null,
      };
      this.conversations.set(c.id, c);
      this.messages.set(c.id, []);
      this.broadcast(`presence-workspace.${c.workspaceId}`, {
        type: 'conversation.created',
        ...this.update(c),
      });
      return [201, this.entity(c)];
    }
    if ((r = m(/^(GET|PATCH) \/api\/v1\/conversations\/(\w+)$/))) {
      const c = this.conversation(user, r[2]!);
      if (r[1] === 'PATCH') {
        if (
          typeof body.title === 'string' &&
          (body.titleSource !== 'auto' || c.titleSource === 'placeholder')
        ) {
          c.title = body.title;
          c.titleSource = (body.titleSource as 'auto' | 'user') ?? 'user';
        }
        if (typeof body.archived === 'boolean') c.archived = body.archived;
        this.conversationUpdated(c);
        return this.entity(c);
      }
      return this.summary(c);
    }
    if ((r = m(/^POST \/api\/v1\/conversations\/(\w+)\/read$/))) {
      this.conversation(user, r[1]!);
      return undefined;
    }
    if ((r = m(/^GET \/api\/v1\/conversations\/(\w+)\/messages$/))) {
      const c = this.conversation(user, r[1]!);
      return { messages: this.messages.get(c.id)!, hasMore: false, rev: c.rev };
    }
    if ((r = m(/^POST \/api\/v1\/conversations\/(\w+)\/cancel$/))) {
      const c = this.conversation(user, r[1]!);
      const run = this.activeRun(c.id);
      const role = this.role(user, c.workspaceId);
      if (run && run.userId !== user.id && role === 'member') {
        throw new HttpError(403, 'forbidden', 'Only its runner or an admin');
      }
      if (run) {
        this.broadcast(`private-conversation.${c.id}`, {
          type: 'run.cancel_requested',
          conversationId: c.id,
          runId: run.id,
          byUserId: user.id,
        });
      }
      return undefined;
    }
    if ((r = m(/^POST \/api\/v1\/conversations\/(\w+)\/runs$/)))
      return [201, this.startRun(user, token!, r[1]!, body)];
    if ((r = m(/^POST \/api\/v1\/runs\/(\w+)\/(events|approvals|heartbeat|finish)$/))) {
      return this.runRequest(user, token!, r[1]!, r[2]!, body);
    }
    throw new HttpError(404, 'not_found', `${method} ${path}`);
  }

  // -------------------------------------------------------------------- runs

  private startRun(user: User, token: string, conversationId: string, raw: unknown) {
    const body = HubRunStartInput.parse(raw);
    const c = this.conversation(user, conversationId);
    if (this.activeRun(c.id)) throw new HttpError(409, 'conversation_busy', 'busy');
    const list = this.messages.get(c.id)!;
    const seq = list.at(-1)?.seq ?? 0;
    const events: HubEvent[] = [];
    let userMessage: Message | null = null;
    let reply: Message;
    if (body.content) {
      userMessage = this.message(c.id, seq + 1, 'user', body.content, 'complete');
      reply = this.message(c.id, seq + 2, 'assistant', [], 'streaming');
      list.push(userMessage, reply);
      if (c.title === null) {
        const first = body.content.find((b) => b.type === 'text');
        c.title = first && first.type === 'text' ? first.text.split('\n')[0]!.slice(0, 60) : null;
        c.titleSource = 'placeholder';
      }
      events.push({ type: 'message.created', message: userMessage, rev: ++c.rev });
      events.push({ type: 'message.created', message: reply, rev: ++c.rev });
    } else {
      const last = list.at(-1);
      if (!last || last.role !== 'assistant' || last.status !== 'error') {
        throw new HttpError(422, 'invalid_request', 'The last reply did not fail');
      }
      reply = Object.assign(last, { content: [], status: 'streaming', error: null });
      events.push({ type: 'message.updated', message: reply, rev: ++c.rev });
    }
    const run: Run = {
      id: body.runId,
      conversationId: c.id,
      replyId: reply.id,
      userId: user.id,
      token,
      lastBatch: 0,
      active: true,
    };
    this.runs.set(run.id, run);
    c.status = 'running';
    c.lastActivityAt = now();
    for (const e of events) this.broadcast(`private-conversation.${c.id}`, e);
    this.broadcast(`private-conversation.${c.id}`, {
      type: 'run.started',
      conversationId: c.id,
      messageId: reply.id,
      runId: run.id,
      userId: user.id,
    });
    this.conversationUpdated(c);
    return {
      runId: run.id,
      userMessage,
      reply,
      conversation: this.entity(c),
      history: list.filter((x) => x.seq < reply.seq),
      leaseSeconds: 30,
    };
  }

  private runRequest(user: User, token: string, runId: string, action: string, raw: unknown) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, 'not_found', 'run');
    if (run.userId !== user.id || run.token !== token)
      throw new HttpError(403, 'forbidden', 'not yours');
    if (!run.active) throw new HttpError(422, 'invalid_request', 'finished');
    const c = this.conversations.get(run.conversationId)!;
    const reply = this.messages.get(c.id)!.find((x) => x.id === run.replyId)!;
    const ref = { conversationId: c.id, messageId: reply.id, runId };
    const channel = `private-conversation.${c.id}`;
    if (action === 'heartbeat') return undefined;
    if (action === 'approvals') {
      c.pending = null;
      c.status = 'running';
      this.conversationUpdated(c);
      return undefined;
    }
    if (action === 'events') {
      const body = HubRunEventsInput.parse(raw);
      if (body.batch <= run.lastBatch) return { rev: c.rev };
      run.lastBatch = body.batch;
      for (const e of body.events) {
        if (e.type === 'run.text_delta') {
          reply.content = appendText(reply.content, e.text);
          this.broadcast(channel, {
            type: 'run.text_delta',
            ...ref,
            rev: ++c.rev,
            text: e.text,
            ...(e.ts !== undefined ? { ts: e.ts } : {}),
          });
        } else if (e.type === 'run.block') {
          reply.content = [...reply.content, e.block];
          this.broadcast(channel, { type: 'run.block', ...ref, rev: ++c.rev, block: e.block });
        } else if (e.type === 'run.tool_call') {
          this.broadcast(channel, {
            type: 'run.tool_call',
            ...ref,
            toolUseId: e.toolUseId,
            toolServerId: e.toolServerId,
            toolName: e.toolName,
            input: e.input,
            requiresApproval: e.requiresApproval,
          });
          if (e.requiresApproval) {
            c.status = 'awaiting-approval';
            c.pending = {
              toolUseId: e.toolUseId,
              toolServerId: e.toolServerId,
              toolName: e.toolName,
              input: e.input,
            };
            this.conversationUpdated(c);
          }
        } else {
          const block: Block = {
            type: 'tool_result',
            toolUseId: e.toolUseId,
            content: e.output,
            isError: e.isError,
            durationMs: e.durationMs,
          };
          reply.content = [...reply.content, block];
          this.broadcast(channel, {
            type: 'run.tool_result',
            ...ref,
            rev: ++c.rev,
            toolUseId: e.toolUseId,
            output: e.output,
            isError: e.isError,
            durationMs: e.durationMs,
          });
        }
      }
      return { rev: c.rev };
    }
    const body = HubRunFinishInput.parse(raw);
    Object.assign(reply, {
      content: body.content,
      status: body.status,
      error: body.status === 'error' ? body.error : null,
    });
    run.active = false;
    c.status = body.status === 'error' ? 'error' : 'idle';
    c.pending = null;
    c.lastActivityAt = now();
    this.broadcast(channel, { type: 'message.updated', message: reply, rev: ++c.rev });
    this.broadcast(
      channel,
      body.status === 'error'
        ? {
            type: 'run.error',
            ...ref,
            code: body.error?.code ?? 'internal',
            message: body.error?.message ?? '',
            retryable: body.error?.retryable ?? false,
          }
        : {
            type: 'run.done',
            ...ref,
            stopReason: body.stopReason ?? (body.status === 'cancelled' ? 'cancelled' : 'end_turn'),
          },
    );
    this.conversationUpdated(c);
    this.lastUsage = body.usage;
    return { message: reply, conversation: this.entity(c) };
  }

  /** The usage the last finished run reported (for assertions). */
  lastUsage: unknown = null;

  // ----------------------------------------------------------------- helpers

  private issue(user: User): string {
    const token = `t${ulid()}`;
    this.tokens.set(token, user.id);
    return token;
  }

  private accept(token: string, user: User): string {
    const invitation = this.invitations.get(token);
    if (!invitation || invitation.email !== user.email) {
      throw new HttpError(404, 'invitation_invalid', 'invalid');
    }
    this.invitations.delete(token);
    this.members.get(invitation.workspaceId)!.set(user.id, invitation.role);
    return invitation.workspaceId;
  }

  private publicUser(user: User) {
    return { id: user.id, name: user.name, email: user.email };
  }

  private workspace(id: string, role: WorkspaceRole): Workspace {
    const w = this.workspaces.get(id)!;
    return { id, name: w.name, role, createdAt: w.createdAt };
  }

  private role(user: User, workspaceId: string): WorkspaceRole {
    const role = this.members.get(workspaceId)?.get(user.id);
    if (!role) throw new HttpError(404, 'not_found', 'workspace');
    return role;
  }

  private conversation(user: User, id: string): ConversationRow {
    const c = this.conversations.get(id);
    if (!c) throw new HttpError(404, 'not_found', 'conversation');
    this.role(user, c.workspaceId);
    return c;
  }

  private activeRun(conversationId: string): Run | undefined {
    return [...this.runs.values()].find((r) => r.conversationId === conversationId && r.active);
  }

  private message(
    conversationId: string,
    seq: number,
    role: Message['role'],
    content: Block[],
    status: Message['status'],
  ): Message {
    return {
      id: ulid(),
      conversationId,
      role,
      content,
      status,
      seq,
      createdAt: now(),
      error: null,
    };
  }

  private entity(c: ConversationRow): Conversation {
    return {
      id: c.id,
      agentId: c.agentId,
      title: c.title,
      status: c.status,
      harnessSessionId: null,
      archived: c.archived,
      lastActivityAt: c.lastActivityAt,
      createdAt: c.createdAt,
    };
  }

  private runner(c: ConversationRow): HubRunner | null {
    const run = this.activeRun(c.id);
    if (!run) return null;
    return {
      userId: run.userId,
      name: this.users.get(run.userId)!.name,
      runId: run.id,
      startedAt: now(),
    };
  }

  private update(c: ConversationRow) {
    return {
      workspaceId: c.workspaceId,
      conversation: this.entity(c),
      pendingApproval: (c.pending ?? null) as never,
      runner: this.runner(c),
    };
  }

  private summary(c: ConversationRow) {
    return { ...this.update(c), unread: 0 };
  }

  private conversationUpdated(c: ConversationRow): void {
    this.broadcast(`presence-workspace.${c.workspaceId}`, {
      type: 'conversation.updated',
      ...this.update(c),
    });
  }

  private mayListen(user: User, channel: string): boolean {
    const [kind, id] = channel.split('.');
    if (kind === 'private-user') return id === user.id;
    if (kind === 'presence-workspace') return this.members.get(id!)?.has(user.id) ?? false;
    if (kind === 'private-conversation') {
      const c = this.conversations.get(id!);
      return !!c && (this.members.get(c.workspaceId)?.has(user.id) ?? false);
    }
    return false;
  }

  // ------------------------------------------------------------------ pusher

  /** Sends a HubEvent to every socket on the channel. */
  broadcast(channel: string, event: HubEvent): void {
    for (const socket of this.sockets) socket.deliver(channel, event);
  }

  register(socket: FakeSocket): void {
    this.sockets.add(socket);
  }

  unregister(socket: FakeSocket): void {
    this.sockets.delete(socket);
    for (const channel of socket.channels.keys()) this.presenceChanged(channel);
  }

  presenceChanged(channel: string): void {
    if (!channel.startsWith('presence-')) return;
    for (const socket of this.sockets) socket.presence(channel, this.presenceOf(channel));
  }

  presenceOf(channel: string): Record<string, { name: string }> {
    const hash: Record<string, { name: string }> = {};
    for (const socket of this.sockets) {
      const member = socket.channels.get(channel);
      if (member) hash[member.id] = { name: member.name };
    }
    return hash;
  }

  /** Closes every socket (the hub restarting): clients reconnect. */
  dropSockets(): void {
    for (const socket of [...this.sockets]) socket.close();
  }
}

/** The server side of one client connection, shaped like a browser WebSocket for the client. */
class FakeSocket {
  readyState = 0;
  readonly channels = new Map<string, { id: string; name: string } | null>();
  private readonly listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  private readonly socketId = `${Math.floor(Math.random() * 1e6)}.${Math.floor(Math.random() * 1e6)}`;

  constructor(
    private readonly hub: FakeHub,
    readonly url: string,
  ) {
    hub.register(this);
    setTimeout(() => {
      this.readyState = 1;
      this.push({
        event: 'pusher:connection_established',
        data: JSON.stringify({ socket_id: this.socketId, activity_timeout: 120 }),
      });
    }, 0);
  }

  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as {
      event: string;
      data: { channel: string; auth?: string; channel_data?: string };
    };
    if (frame.event === 'pusher:subscribe') {
      const { channel, auth } = frame.data;
      if (auth !== `${this.hub.key}:${this.socketId}:${channel}`) {
        this.push({ event: 'pusher:error', data: JSON.stringify({ message: 'bad auth' }) });
        return;
      }
      const member = frame.data.channel_data
        ? (JSON.parse(frame.data.channel_data) as { user_id: string; user_info: { name: string } })
        : null;
      this.channels.set(
        channel,
        member ? { id: member.user_id, name: member.user_info.name } : null,
      );
      this.push({
        event: 'pusher_internal:subscription_succeeded',
        channel,
        data: JSON.stringify(
          channel.startsWith('presence-')
            ? { presence: { hash: this.hub.presenceOf(channel) } }
            : {},
        ),
      });
      this.hub.presenceChanged(channel);
    } else if (frame.event === 'pusher:unsubscribe') {
      this.channels.delete(frame.data.channel);
      this.hub.presenceChanged(frame.data.channel);
    } else if (frame.event === 'pusher:ping') {
      this.push({ event: 'pusher:pong', data: '{}' });
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.hub.unregister(this);
    for (const fn of this.listeners.get('close') ?? []) fn({});
  }

  deliver(channel: string, event: HubEvent): void {
    if (this.readyState !== 1 || !this.channels.has(channel)) return;
    this.push({ event: event.type, channel, data: JSON.stringify(event) });
  }

  /** Presence as Pusher would report it: member_added / member_removed diffs, simplified to a fresh hash. */
  presence(channel: string, hash: Record<string, { name: string }>): void {
    if (this.readyState !== 1 || !this.channels.has(channel)) return;
    this.push({
      event: 'pusher_internal:subscription_succeeded',
      channel,
      data: JSON.stringify({ presence: { hash } }),
    });
  }

  private push(frame: Record<string, unknown>): void {
    // Delivered asynchronously, like a real socket.
    setTimeout(() => {
      for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
    }, 0);
  }
}
