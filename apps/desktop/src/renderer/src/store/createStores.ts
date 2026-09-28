import { isCommand } from '../../../shared/shortcuts';
import type { Backend } from '../backend/Backend';
import type { HubApi } from '../backend/hub/HubApi';
import { runCommand } from '../commands';
import { applyLanguage } from '../i18n';
import { createAgentsStore } from './agents';
import { createAppStore } from './app';
import { createConnectionsStore } from './connections';
import type { Stores } from './context';
import { createConversationsStore } from './conversations';
import { createGoogleDriveStore } from './googleDrive';
import type { HubStore } from './hub';
import { createMessagesStore } from './messages';
import { createSettingsStore } from './settings';
import { createToolServersStore } from './toolServers';
import { createTransferStore } from './transfer';
import { createUiStore } from './ui';
import { createUpdatesStore } from './updates';
import { createUsageStore } from './usage';
import { createWorkspaceStore } from './workspace';

/** Every store over one backend: Personal's, or a workspace's (rebuilt on a switch). */
export function createStores(backend: Backend, hub: HubStore, api: HubApi): Stores {
  const stores: Stores = {
    app: createAppStore(backend),
    connections: createConnectionsStore(backend),
    agents: createAgentsStore(backend),
    conversations: createConversationsStore(backend),
    messages: createMessagesStore(backend),
    toolServers: createToolServersStore(backend),
    googleDrive: createGoogleDriveStore(backend),
    usage: createUsageStore(backend),
    ui: createUiStore(backend),
    updates: createUpdatesStore(backend),
    settings: createSettingsStore(backend, { onChange: (s) => applyLanguage(s.language) }),
    transfer: createTransferStore(backend, {
      // What an import adds.
      afterImport: async () => {
        await Promise.all([
          stores.connections.getState().load(),
          stores.agents.getState().load(),
          stores.toolServers.getState().load(),
        ]);
      },
    }),
    workspace: createWorkspaceStore(backend.workspace(), api, {
      gone: () => hub.getState().switchTo(null),
      renamed: () => hub.getState().loadWorkspaces(),
    }),
  };
  return stores;
}

/** Feeds the backend's events to the stores and loads them; returns what undoes it. */
export function startStores(stores: Stores, backend: Backend, hub: HubStore): () => void {
  const off = backend.onEvent((event) => {
    if (event.type === 'menu.command') {
      if (isCommand(event.command)) runCommand(stores, event.command);
      return;
    }
    if (event.type === 'workspace.changed') {
      // Another member changed shared data.
      if (event.what === 'agents') void stores.agents.getState().load();
      if (event.what === 'conversations') void stores.conversations.getState().load();
      if (event.what === 'toolServers') void stores.toolServers.getState().load();
    }
    hub.getState().handleEvent(event);
    stores.app.getState().handleEvent(event);
    stores.conversations.getState().handleEvent(event);
    stores.messages.getState().handleEvent(event);
    stores.updates.getState().handleEvent(event);
    stores.workspace.getState().handleEvent(event);
    // A finished reply wrote a usage record; the right panel shows its totals.
    if (event.type === 'message.updated' && event.message.status !== 'streaming') {
      void stores.usage.getState().loadConversation(event.message.conversationId);
    }
  });
  void stores.app.getState().init();
  void stores.settings.getState().load();
  void stores.updates.getState().load();
  void stores.agents.getState().load();
  void stores.conversations.getState().load();
  // The agent form's Tools checklist and the Tools screen share this list.
  void stores.toolServers.getState().load();
  void stores.googleDrive.getState().load();
  void stores.workspace.getState().load();
  // First run lands on Connections (setup); once one exists, on Agents. A workspace opens on Agents.
  void stores.connections
    .getState()
    .load()
    .then(() => {
      if (backend.workspace() || stores.connections.getState().items.length > 0) {
        stores.app.getState().suggestSection('agents');
      }
    });
  return off;
}
