import { beforeEach, describe, expect, it } from 'vitest';
import { adjacent, runCommand } from './commands';
import { createAgentsStore } from './store/agents';
import { createAppStore } from './store/app';
import { createConnectionsStore } from './store/connections';
import type { Stores } from './store/context';
import { createConversationsStore } from './store/conversations';
import { createGoogleDriveStore } from './store/googleDrive';
import { createMessagesStore } from './store/messages';
import { createSettingsStore } from './store/settings';
import { fakeBackend } from './store/testBackend';
import { createToolServersStore } from './store/toolServers';
import { createTransferStore } from './store/transfer';
import { createUiStore } from './store/ui';
import { createUpdatesStore } from './store/updates';
import { createUsageStore } from './store/usage';

let backend: ReturnType<typeof fakeBackend>;
let stores: Stores;

beforeEach(() => {
  backend = fakeBackend();
  stores = {
    app: createAppStore(backend),
    connections: createConnectionsStore(backend),
    agents: createAgentsStore(backend),
    conversations: createConversationsStore(backend),
    messages: createMessagesStore(backend),
    toolServers: createToolServersStore(backend),
    googleDrive: createGoogleDriveStore(backend),
    usage: createUsageStore(backend),
    ui: createUiStore(backend),
    transfer: createTransferStore(backend),
    settings: createSettingsStore(backend),
    updates: createUpdatesStore(backend),
  };
});

describe('adjacent', () => {
  it('wraps both ways and starts at an end when nothing is open', () => {
    expect(adjacent(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(adjacent(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(adjacent(['a', 'b'], null, 1)).toBe('a');
    expect(adjacent(['a', 'b'], null, -1)).toBe('b');
    expect(adjacent([], null, 1)).toBeNull();
  });
});

describe('runCommand', () => {
  it('navigates sections and toggles the overlays', () => {
    runCommand(stores, 'goUsage');
    expect(stores.app.getState().section).toBe('usage');
    runCommand(stores, 'settings');
    expect(stores.app.getState().section).toBe('settings');
    runCommand(stores, 'quickSwitcher');
    expect(stores.ui.getState().quickSwitcherOpen).toBe(true);
    runCommand(stores, 'shortcuts');
    expect(stores.ui.getState()).toMatchObject({ shortcutsOpen: true, quickSwitcherOpen: false });
  });

  it('moves between the agent’s conversations and starts a new one', () => {
    stores.agents.getState().select('a1');
    stores.conversations.setState({ idsByAgent: { a1: ['k1', 'k2', 'k3'] } });
    stores.app.getState().setSection('agents');
    runCommand(stores, 'nextConversation'); // k1 is open (the most recent)
    expect(stores.conversations.getState().selectedByAgent.a1).toBe('k2');
    runCommand(stores, 'previousConversation');
    runCommand(stores, 'previousConversation');
    expect(stores.conversations.getState().selectedByAgent.a1).toBe('k3');
    runCommand(stores, 'newConversation');
    expect(stores.conversations.getState().selectedByAgent.a1).toBeNull();
  });

  it('exports the open conversation and asks the composer to attach, only in a chat', () => {
    runCommand(stores, 'exportConversation');
    runCommand(stores, 'attach');
    expect(backend.conversations.exportMarkdown).not.toHaveBeenCalled();
    expect(stores.ui.getState().attachRequest).toBe(0);

    stores.agents.getState().select('a1');
    stores.conversations.setState({ idsByAgent: { a1: ['k1'] } });
    stores.app.getState().setSection('agents');
    runCommand(stores, 'exportConversation');
    runCommand(stores, 'attach');
    expect(backend.conversations.exportMarkdown).toHaveBeenCalledWith('k1');
    expect(stores.ui.getState().attachRequest).toBe(1);
  });
});
