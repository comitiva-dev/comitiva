import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AgentsState, AgentsStore } from './agents';
import type { AppState, AppStore } from './app';
import type { ConnectionsState, ConnectionsStore } from './connections';
import type { ConversationsState, ConversationsStore } from './conversations';
import type { MessagesState, MessagesStore } from './messages';
import type { ToolServersState, ToolServersStore } from './toolServers';

export interface Stores {
  app: AppStore;
  connections: ConnectionsStore;
  agents: AgentsStore;
  conversations: ConversationsStore;
  messages: MessagesStore;
  toolServers: ToolServersStore;
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

/** For effects and handlers that need the current state without subscribing. */
export function useStoreApis(): Stores {
  return useStores();
}
