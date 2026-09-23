import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AgentsState, AgentsStore } from './agents';
import type { AppState, AppStore } from './app';
import type { ConnectionsState, ConnectionsStore } from './connections';
import type { ConversationsState, ConversationsStore } from './conversations';
import type { GoogleDriveState, GoogleDriveStore } from './googleDrive';
import type { MessagesState, MessagesStore } from './messages';
import type { ToolServersState, ToolServersStore } from './toolServers';
import type { SettingsState, SettingsStore } from './settings';
import type { TransferState, TransferStore } from './transfer';
import type { UiState, UiStore } from './ui';
import type { UsageState, UsageStore } from './usage';

export interface Stores {
  app: AppStore;
  connections: ConnectionsStore;
  agents: AgentsStore;
  conversations: ConversationsStore;
  messages: MessagesStore;
  toolServers: ToolServersStore;
  usage: UsageStore;
  googleDrive: GoogleDriveStore;
  ui: UiStore;
  transfer: TransferStore;
  settings: SettingsStore;
}

const StoresContext = createContext<Stores | null>(null);

export function StoresProvider({ stores, children }: { stores: Stores; children: ReactNode }) {
  return <StoresContext.Provider value={stores}>{children}</StoresContext.Provider>;
}

function useStores(): Stores {
  const stores = useContext(StoresContext);
  if (!stores) throw new Error('StoresProvider is missing');
  return stores;
}

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(useStores().app, selector);
}

export function useConnections<T>(selector: (state: ConnectionsState) => T): T {
  return useStore(useStores().connections, selector);
}

export function useAgents<T>(selector: (state: AgentsState) => T): T {
  return useStore(useStores().agents, selector);
}

export function useConversations<T>(selector: (state: ConversationsState) => T): T {
  return useStore(useStores().conversations, selector);
}

export function useMessages<T>(selector: (state: MessagesState) => T): T {
  return useStore(useStores().messages, selector);
}

export function useToolServers<T>(selector: (state: ToolServersState) => T): T {
  return useStore(useStores().toolServers, selector);
}

export function useGoogleDrive<T>(selector: (state: GoogleDriveState) => T): T {
  return useStore(useStores().googleDrive, selector);
}

export function useUsage<T>(selector: (state: UsageState) => T): T {
  return useStore(useStores().usage, selector);
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useStores().ui, selector);
}

export function useTransfer<T>(selector: (state: TransferState) => T): T {
  return useStore(useStores().transfer, selector);
}

export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(useStores().settings, selector);
}

/** For effects and handlers that need the current state without subscribing. */
export function useStoreApis(): Stores {
  return useStores();
}
