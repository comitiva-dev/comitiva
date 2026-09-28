import { createStore } from 'zustand/vanilla';
import type {
  Agent,
  ErrorCode,
  HubEvent,
  HubStatus,
  InvitationPreview,
  SharedAgent,
  Workspace,
} from '@comitiva/contract';
import { errorCode, type Backend, type BackendEvent } from '../backend/Backend';
import { invitationToken, type HubApi } from '../backend/hub/HubApi';
import type { HubExecutor, HubTransport } from '../backend/hub/HubTransport';

export interface HubState {
  /** Null until loaded. */
  status: HubStatus | null;
  workspaces: Workspace[];
  /** The workspace the window shows; null is Personal. */
  activeWorkspaceId: string | null;
  busy: 'configure' | 'signin' | 'signout' | 'workspace' | 'join' | 'share' | null;
  notice: ErrorCode | null;
  /** Where the last shared agent went (for the confirmation). */
  shared: { agentName: string; workspaceName: string } | null;

  init(): Promise<void>;
  configure(url: string | null): Promise<boolean>;
  register(input: {
    name: string;
    email: string;
    password: string;
    invitationToken?: string;
  }): Promise<boolean>;
  login(input: { email: string; password: string }): Promise<boolean>;
  logout(): Promise<void>;
  loadWorkspaces(): Promise<void>;
  /** Creates a workspace and shows it; null when it failed. */
  createWorkspace(name: string): Promise<string | null>;
  switchTo(workspaceId: string | null): Promise<void>;
  /** What an invitation link invites to, or null (see `notice`). */
  preview(link: string): Promise<InvitationPreview | null>;
  /** Accepts an invitation link and shows its workspace. */
  join(link: string): Promise<boolean>;
  /** Copies a Personal agent into a workspace; this member runs it with the same connection. */
  shareAgent(agent: Agent, provider: string, workspaceId: string): Promise<boolean>;
  dismissNotice(): void;
  dismissShared(): void;
  handleEvent(event: BackendEvent): void;
}

export type HubStore = ReturnType<typeof createHubStore>;

export interface HubStoreDeps {
  /** The Personal backend: hub sign-in and app settings. */
  local: Backend;
  api: HubApi;
  transport: HubTransport;
  executor: HubExecutor;
}

/**
 * The hub session, above any one workspace: who is signed in, the
 * workspaces, and which one the window shows (the whole UI is rebuilt on a
 * switch). It listens to the user's own channel for workspaces joined, left
 * or renamed.
 */
export function createHubStore({ local, api, transport, executor }: HubStoreDeps) {
  return createStore<HubState>()((set, get) => {
    let userChannel: string | null = null;

    const guarded = async <T>(
      busy: HubState['busy'],
      fn: () => Promise<T>,
    ): Promise<T | undefined> => {
      set({ busy, notice: null });
      try {
        return await fn();
      } catch (err) {
        set({ notice: errorCode(err) });
        return undefined;
      } finally {
        set({ busy: null });
      }
    };

    /** Follows the signed-in user's channel; workspaces load when someone is signed in. */
    const onStatus = async (status: HubStatus) => {
      const userChanged = (get().status?.user?.id ?? null) !== (status.user?.id ?? null);
      set({ status });
      const channel = status.user ? `private-user.${status.user.id}` : null;
      if (channel !== userChannel) {
        if (userChannel) void transport.unsubscribe(userChannel).catch(() => {});
        userChannel = channel;
        if (channel) void transport.subscribe(channel).catch(() => {});
      }
      if (status.user) {
        if (userChanged || get().workspaces.length === 0) await get().loadWorkspaces();
      } else {
        set({ workspaces: [] });
        if (get().activeWorkspaceId) await get().switchTo(null);
      }
    };

    transport.onEvent((channel, event: HubEvent) => {
      if (channel !== userChannel) return;
      if (event.type === 'workspace.left' && event.workspaceId === get().activeWorkspaceId) {
        void get().switchTo(null);
      }
      if (event.type.startsWith('workspace.')) void get().loadWorkspaces();
    });

    return {
      status: null,
      workspaces: [],
      activeWorkspaceId: null,
      busy: null,
      notice: null,
      shared: null,

      async init() {
        const [status, settings] = await Promise.all([local.hub.getStatus(), local.settings.get()]);
        set({ activeWorkspaceId: settings.activeWorkspaceId });
        await onStatus(status);
      },

      async configure(url) {
        const status = await guarded('configure', () => local.hub.configure(url));
        if (status) await onStatus(status);
        return status !== undefined;
      },

      async register(input) {
        const status = await guarded('signin', () => local.hub.register(input));
        if (status) await onStatus(status);
        return status !== undefined;
      },

      async login(input) {
        const status = await guarded('signin', () => local.hub.login(input));
        if (status) await onStatus(status);
        return status !== undefined;
      },

      async logout() {
        const status = await guarded('signout', () => local.hub.logout());
        if (status) await onStatus(status);
      },

      async loadWorkspaces() {
        try {
          const workspaces = await api.workspaces.list();
          set({ workspaces });
          const active = get().activeWorkspaceId;
          if (active && !workspaces.some((w) => w.id === active)) await get().switchTo(null);
        } catch (err) {
          set({ notice: errorCode(err) });
        }
      },

      async createWorkspace(name) {
        const created = await guarded('workspace', () => api.workspaces.create(name));
        if (!created) return null;
        set((s) => ({ workspaces: [...s.workspaces.filter((w) => w.id !== created.id), created] }));
        await get().switchTo(created.id);
        return created.id;
      },

      async switchTo(workspaceId) {
        if (get().activeWorkspaceId === workspaceId) return;
        set({ activeWorkspaceId: workspaceId });
        await local.settings.update({ activeWorkspaceId: workspaceId }).catch(() => {});
      },

      async preview(link) {
        const token = invitationToken(link);
        if (!token) {
          set({ notice: 'invitation_invalid' });
          return null;
        }
        return (await guarded('join', () => api.invitations.preview(token))) ?? null;
      },

      async join(link) {
        const token = invitationToken(link);
        if (!token) {
          set({ notice: 'invitation_invalid' });
          return false;
        }
        const workspace = await guarded('join', () => api.invitations.accept(token));
        if (!workspace) return false;
        await get().loadWorkspaces();
        await get().switchTo(workspace.id);
        return true;
      },

      async shareAgent(agent, provider, workspaceId) {
        const workspace = get().workspaces.find((w) => w.id === workspaceId);
        const done = await guarded('share', async () => {
          const shared = await transport.request<SharedAgent>(
            'POST',
            `/api/v1/workspaces/${workspaceId}/agents`,
            {
              body: {
                name: agent.name,
                avatar: agent.avatar,
                provider,
                model: agent.model,
                role: agent.role,
                params: agent.params,
                // This machine's tool servers and folders stay in the sharer's link.
                toolServerIds: [],
                permissionPolicy: agent.permissionPolicy,
                tags: agent.tags,
              },
            },
          );
          await executor.setLink({
            agentId: shared.id,
            workspaceId,
            connectionId: agent.connectionId,
            roots: agent.roots,
            toolServerIds: agent.toolServerIds,
          });
          return true;
        });
        if (done && workspace)
          set({ shared: { agentName: agent.name, workspaceName: workspace.name } });
        return done === true;
      },

      dismissNotice: () => set({ notice: null }),
      dismissShared: () => set({ shared: null }),

      handleEvent(event) {
        if (event.type === 'hub.status') void onStatus(event.status);
      },
    };
  });
}
