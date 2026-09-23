import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { App } from './App';
import { LocalBackend } from './backend/LocalBackend';
import { createAgentsStore } from './store/agents';
import { createAppStore } from './store/app';
import { createConnectionsStore } from './store/connections';
import { StoresProvider } from './store/context';
import { createConversationsStore } from './store/conversations';
import { createGoogleDriveStore } from './store/googleDrive';
import { createMessagesStore } from './store/messages';
import { createToolServersStore } from './store/toolServers';
import { createTransferStore } from './store/transfer';
import { createUiStore } from './store/ui';
import { createUsageStore } from './store/usage';

const backend = new LocalBackend();
const stores = {
  app: createAppStore(backend),
  connections: createConnectionsStore(backend),
  agents: createAgentsStore(backend),
  conversations: createConversationsStore(backend),
  messages: createMessagesStore(backend),
  toolServers: createToolServersStore(backend),
  googleDrive: createGoogleDriveStore(backend),
  usage: createUsageStore(backend),
  ui: createUiStore(backend),
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
};
backend.onEvent((event) => {
  stores.app.getState().handleEvent(event);
  stores.conversations.getState().handleEvent(event);
  stores.messages.getState().handleEvent(event);
  // A finished reply wrote a usage record; the right panel shows its totals.
  if (event.type === 'message.updated' && event.message.status !== 'streaming') {
    void stores.usage.getState().loadConversation(event.message.conversationId);
  }
});
void stores.app.getState().init();
void stores.agents.getState().load();
void stores.conversations.getState().load();
// The agent form's Tools checklist and the Tools screen share this list.
void stores.toolServers.getState().load();
void stores.googleDrive.getState().load();
// First run lands on Connections (setup); once one exists, on Agents.
void stores.connections
  .getState()
  .load()
  .then(() => {
    if (stores.connections.getState().items.length > 0) {
      stores.app.getState().suggestSection('agents');
    }
  });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoresProvider stores={stores}>
      <App />
    </StoresProvider>
  </StrictMode>,
);
