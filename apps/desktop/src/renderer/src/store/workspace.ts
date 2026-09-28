import { createStore } from 'zustand/vanilla';
import type {
  ErrorCode,
  InvitableRole,
  Invitation,
  InvitationCreated,
  Member,
  PresenceMember,
  WorkspaceRole,
} from '@comitiva/contract';
import { errorCode, type BackendEvent, type WorkspaceContext } from '../backend/Backend';
import type { HubApi } from '../backend/hub/HubApi';

export interface WorkspaceState {
  members: Member[];
  /** Open invitations (admins only). */
  invitations: Invitation[];
  /** Who is online now (Reverb presence). */
  online: PresenceMember[];
  /** The link of the invitation just created, shown once to copy. */
  created: InvitationCreated | null;
  busy: boolean;
  notice: ErrorCode | null;

  load(): Promise<void>;
  invite(email: string, role: InvitableRole): Promise<boolean>;
  revoke(id: string): Promise<void>;
  setRole(userId: string, role: WorkspaceRole): Promise<void>;
  remove(userId: string): Promise<void>;
  rename(name: string): Promise<boolean>;
  /** Leaves the workspace (then the window goes back to Personal). */
  leave(): Promise<boolean>;
  /** Owners only: deletes the workspace and everything in it. */
  deleteWorkspace(): Promise<boolean>;
  dismissCreated(): void;
  dismissNotice(): void;
  handleEvent(event: BackendEvent): void;
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

/** The workspace on screen: members, invitations and who is online. Empty in Personal. */
export function createWorkspaceStore(
  workspace: WorkspaceContext | null,
  api: HubApi,
  hooks: { gone(): Promise<void>; renamed(): Promise<void> },
) {
  return createStore<WorkspaceState>()((set, get) => {
    const guarded = async (fn: () => Promise<void>): Promise<boolean> => {
      set({ busy: true, notice: null });
      try {
        await fn();
        return true;
      } catch (err) {
        set({ notice: errorCode(err) });
        return false;
      } finally {
        set({ busy: false });
      }
    };
    const admin = workspace?.role === 'owner' || workspace?.role === 'admin';

    return {
      members: [],
      invitations: [],
      online: [],
      created: null,
      busy: false,
      notice: null,

      async load() {
        if (!workspace) return;
        try {
          const [members, invitations] = await Promise.all([
            api.members.list(workspace.id),
            admin ? api.invitations.list(workspace.id) : Promise.resolve([]),
          ]);
          set({ members, invitations });
        } catch (err) {
          set({ notice: errorCode(err) });
        }
      },

      invite: (email, role) =>
        guarded(async () => {
          const created = await api.invitations.create(workspace!.id, email, role);
          set({ created });
          await get().load();
        }),

      revoke: async (id) => {
        await guarded(async () => {
          await api.invitations.revoke(id);
          await get().load();
        });
      },

      setRole: async (userId, role) => {
        await guarded(async () => {
          await api.members.setRole(workspace!.id, userId, role);
          await get().load();
        });
      },

      remove: async (userId) => {
        await guarded(async () => {
          await api.members.remove(workspace!.id, userId);
          await get().load();
        });
      },

      rename: (name) =>
        guarded(async () => {
          await api.workspaces.rename(workspace!.id, name);
          await hooks.renamed();
        }),

      leave: async () => {
        const ok = await guarded(() => api.members.leave(workspace!.id));
        if (ok) await hooks.gone();
        return ok;
      },

      deleteWorkspace: async () => {
        const ok = await guarded(() => api.workspaces.delete(workspace!.id));
        if (ok) await hooks.gone();
        return ok;
      },

      dismissCreated: () => set({ created: null }),
      dismissNotice: () => set({ notice: null }),

      handleEvent(event) {
        if (event.type === 'presence.updated') set({ online: event.members });
        if (event.type === 'workspace.changed' && event.what === 'members') void get().load();
      },
    };
  });
}
