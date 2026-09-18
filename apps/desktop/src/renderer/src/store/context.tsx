import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { SpikeState, SpikeStore } from './spike';

const SpikeStoreContext = createContext<SpikeStore | null>(null);

export function SpikeStoreProvider({
  store,
  children,
}: {
  store: SpikeStore;
  children: ReactNode;
}) {
  return <SpikeStoreContext.Provider value={store}>{children}</SpikeStoreContext.Provider>;
}

export function useSpike<T>(selector: (state: SpikeState) => T): T {
  const store = useContext(SpikeStoreContext);
  if (!store) throw new Error('SpikeStoreProvider is missing');
  return useStore(store, selector);
}
