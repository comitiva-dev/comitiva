import { describe, expect, it } from 'vitest';
import {
  HubEvent,
  HubRunEventsInput,
  HubRunFinishInput,
  HubRunStartInput,
  InvitationDraft,
  SharedAgentDraft,
  WorkspaceToolServerDraft,
  generateJsonSchemas,
  ipcInvoke,
} from '../src/index.js';
import { now, userMessage } from './fixtures.js';

const id = (n: number) => `01J0000000000000000000${String(n).padStart(4, '0')}`;

describe('hub contract', () => {
  it('shares an agent by provider and model, never by connection or folders', () => {
    const draft = SharedAgentDraft.parse({
      name: 'Researcher',
      avatar: { color: 'indigo' },
      provider: 'anthropic',
    });
    expect(draft).toMatchObject({
      model: null,
      role: '',
      toolServerIds: [],
      permissionPolicy: 'ask',
    });
    expect(draft).not.toHaveProperty('connectionId');
    const withLocal = SharedAgentDraft.parse({
      name: 'x',
      avatar: { color: 'indigo' },
      provider: 'anthropic',
      connectionId: id(1),
      roots: [{ path: '/home/ana', mode: 'read' }],
    });
    // Unknown keys are stripped: local fields cannot reach the hub.
    expect(withLocal).not.toHaveProperty('connectionId');
    expect(withLocal).not.toHaveProperty('roots');
  });

  it('keeps workspace tool servers to http, and secret headers without a value', () => {
    const ok = WorkspaceToolServerDraft.safeParse({
      name: 'Search',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { secretRef: 'member' }, 'X-Team': { value: 'a' } },
    });
    expect(ok.success).toBe(true);
    expect(
      WorkspaceToolServerDraft.safeParse({ name: 'x', url: 'file:///etc/passwd' }).success,
    ).toBe(false);
    expect(
      WorkspaceToolServerDraft.safeParse({
        name: 'x',
        url: 'https://a.example',
        headers: { Authorization: { secretRef: 'toolServer:1:header:Authorization' } },
      }).success,
    ).toBe(false);
  });

  it('invites as admin or member, not owner', () => {
    expect(InvitationDraft.parse({ email: 'ana@example.com' }).role).toBe('member');
    expect(InvitationDraft.safeParse({ email: 'ana@example.com', role: 'owner' }).success).toBe(
      false,
    );
  });

  it('starts a run with content, or without it for a retry', () => {
    expect(HubRunStartInput.safeParse({ runId: id(1) }).success).toBe(true);
    expect(
      HubRunStartInput.safeParse({ runId: id(1), content: [{ type: 'text', text: 'Hi' }] }).success,
    ).toBe(true);
    expect(
      HubRunStartInput.safeParse({ runId: id(1), content: [{ type: 'text', text: ' ' }] }).success,
    ).toBe(false);
  });

  it('publishes only the run events that change a reply', () => {
    const ok = HubRunEventsInput.safeParse({
      batch: 1,
      events: [
        { type: 'run.text_delta', runId: id(1), text: 'Hel', ts: 1 },
        { type: 'run.block', runId: id(1), block: { type: 'text', text: 'x' } },
        {
          type: 'run.tool_call',
          runId: id(1),
          toolUseId: 't1',
          toolServerId: 'filesystem',
          toolName: 'read_file',
          input: { path: 'a' },
          requiresApproval: false,
        },
        {
          type: 'run.tool_result',
          runId: id(1),
          toolUseId: 't1',
          output: [{ type: 'text', text: 'ok' }],
          isError: false,
          durationMs: 3,
        },
      ],
    });
    expect(ok.success).toBe(true);
    // Session ids are per desktop, usage comes with finish, terminal events are finish.
    for (const e of [
      { type: 'run.session', runId: id(1), harnessSessionId: 's' },
      { type: 'run.usage', runId: id(1), inputTokens: 1, outputTokens: 1, estimated: false },
      { type: 'run.done', runId: id(1), stopReason: 'end_turn' },
    ]) {
      expect(HubRunEventsInput.safeParse({ batch: 1, events: [e] }).success, e.type).toBe(false);
    }
    expect(HubRunEventsInput.safeParse({ batch: 0, events: [] }).success).toBe(false);
  });

  it('finishes a run with its final content and usage', () => {
    expect(
      HubRunFinishInput.safeParse({
        status: 'complete',
        content: [{ type: 'text', text: 'Hello' }],
        error: null,
        usage: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          estimated: false,
          estimatedCostUsd: 0.0001,
          costSource: 'table',
          costEstimated: false,
          latencyMs: 120,
        },
      }).success,
    ).toBe(true);
  });

  it('numbers message-changing events and leaves the others unnumbered', () => {
    const ref = { conversationId: id(2), messageId: id(3), runId: id(1) };
    expect(HubEvent.safeParse({ type: 'run.text_delta', ...ref, rev: 4, text: 'a' }).success).toBe(
      true,
    );
    expect(HubEvent.safeParse({ type: 'run.text_delta', ...ref, text: 'a' }).success).toBe(false);
    expect(
      HubEvent.safeParse({ type: 'message.created', message: userMessage, rev: 1 }).success,
    ).toBe(true);
    const done = HubEvent.parse({ type: 'run.done', ...ref, stopReason: 'end_turn', rev: 9 });
    expect(done).not.toHaveProperty('rev');
    expect(
      HubEvent.safeParse({
        type: 'conversation.updated',
        workspaceId: id(9),
        conversation: {
          id: id(2),
          agentId: id(5),
          title: null,
          status: 'running',
          harnessSessionId: null,
          archived: false,
          lastActivityAt: now,
          createdAt: now,
        },
        pendingApproval: null,
        runner: { userId: id(6), name: 'Ana', runId: id(1), startedAt: now },
      }).success,
    ).toBe(true);
  });

  it('keeps hub requests under the versioned API', () => {
    const req = ipcInvoke['hub.request'].input;
    expect(req.safeParse({ method: 'GET', path: '/api/v1/workspaces' }).success).toBe(true);
    for (const path of [
      '/broadcasting/auth',
      'https://evil.example/api/v1/x',
      '/api/v1/../x',
      '/api/v1/x?y',
    ]) {
      expect(req.safeParse({ method: 'GET', path }).success, path).toBe(false);
    }
    const sub = ipcInvoke['hub.subscribe'].input;
    expect(sub.safeParse({ channel: `private-conversation.${id(2)}` }).success).toBe(true);
    expect(sub.safeParse({ channel: 'private-anything.x' }).success).toBe(false);
  });

  it('publishes the hub schemas as JSON Schema', () => {
    const files = Object.keys(generateJsonSchemas());
    for (const name of ['HubEvent', 'HubRunEventsInput', 'SharedAgent', 'HubMeta', 'MessagePage']) {
      expect(files).toContain(`${name}.json`);
    }
  });
});
