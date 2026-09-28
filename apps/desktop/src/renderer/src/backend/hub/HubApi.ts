import type {
  InvitableRole,
  Invitation,
  InvitationCreated,
  InvitationPreview,
  Member,
  Workspace,
  WorkspaceRole,
} from '@comitiva/contract';
import type { HubTransport } from './HubTransport';

/** The workspace, member and invitation endpoints (the hub's docs/api.md). */
export function createHubApi(transport: HubTransport) {
  const ws = (id: string) => `/api/v1/workspaces/${id}`;
  return {
    workspaces: {
      list: () => transport.request<Workspace[]>('GET', '/api/v1/workspaces'),
      create: (name: string) =>
        transport.request<Workspace>('POST', '/api/v1/workspaces', { body: { name } }),
      rename: (id: string, name: string) =>
        transport.request<Workspace>('PATCH', ws(id), { body: { name } }),
      delete: (id: string) => transport.request<void>('DELETE', ws(id)),
    },
    members: {
      list: (workspaceId: string) =>
        transport.request<Member[]>('GET', `${ws(workspaceId)}/members`),
      setRole: (workspaceId: string, userId: string, role: WorkspaceRole) =>
        transport.request<Member>('PATCH', `${ws(workspaceId)}/members/${userId}`, {
          body: { role },
        }),
      remove: (workspaceId: string, userId: string) =>
        transport.request<void>('DELETE', `${ws(workspaceId)}/members/${userId}`),
      leave: (workspaceId: string) => transport.request<void>('POST', `${ws(workspaceId)}/leave`),
    },
    invitations: {
      list: (workspaceId: string) =>
        transport.request<Invitation[]>('GET', `${ws(workspaceId)}/invitations`),
      create: (workspaceId: string, email: string, role: InvitableRole) =>
        transport.request<InvitationCreated>('POST', `${ws(workspaceId)}/invitations`, {
          body: { email, role },
        }),
      revoke: (id: string) => transport.request<void>('DELETE', `/api/v1/invitations/${id}`),
      preview: (token: string) =>
        transport.request<InvitationPreview>('GET', `/api/v1/invitations/${token}`),
      accept: (token: string) =>
        transport.request<Workspace>('POST', `/api/v1/invitations/${token}/accept`),
    },
  };
}

export type HubApi = ReturnType<typeof createHubApi>;

/** The token of an invitation link (`…/invite/<token>`), or the token itself when pasted alone. */
export function invitationToken(input: string): string | null {
  const text = input.trim();
  const fromLink = /\/invite\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(text);
  if (fromLink) return fromLink[1]!;
  return /^[A-Za-z0-9]{20,}$/.test(text) ? text : null;
}
