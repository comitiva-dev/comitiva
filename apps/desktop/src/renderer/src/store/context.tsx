import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AppState, AppStore } from './app';
import type { ConnectionsState, ConnectionsStore } from './connections';

export interface Stores {
  app: AppStore;
  connections: ConnectionsStore;
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
