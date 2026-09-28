import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { App } from './App';
import type { Backend } from './backend/Backend';
import type { HubApi } from './backend/hub/HubApi';
import type { HubExecutor, HubTransport } from './backend/hub/HubTransport';
import type { LocalBackend } from './backend/LocalBackend';
import { RemoteBackend } from './backend/RemoteBackend';
import { HubProvider, StoresProvider } from './store/context';
import { createStores, startStores } from './store/createStores';
import type { HubStore } from './store/hub';

/**
 * Picks the backend for what the window shows: Personal (LocalBackend) or a
 * hub workspace (RemoteBackend), and rebuilds every store on a switch, so no
 * state of one scope leaks into the other.
 */
export function Root({
  local,
  hub,
  api,
  transport,
  executor,
}: {
  local: LocalBackend;
  hub: HubStore;
  api: HubApi;
  transport: HubTransport;
  executor: HubExecutor;
}) {
  const activeId = useStore(hub, (s) => s.activeWorkspaceId);
  const workspace = useStore(hub, (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const userId = useStore(hub, (s) => s.status?.user?.id ?? null);
  const role = workspace?.role;
  const name = workspace?.name;

  // A workspace is shown once it is known (listed) and someone is signed in.
  const context = useMemo(
    () =>
      activeId && userId && role && name !== undefined
        ? { id: activeId, name, role, userId }
        : null,
    [activeId, userId, role, name],
  );
  const backend: Backend = useMemo(
    () => (context ? new RemoteBackend({ local, transport, executor, workspace: context }) : local),
    // The name can change without a new backend; the context object carries it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context?.id, context?.role, context?.userId, local, transport, executor],
  );
  const stores = useMemo(() => createStores(backend, hub, api), [backend, hub, api]);

  useEffect(() => {
    const stop = startStores(stores, backend, hub);
    return () => {
      stop();
      if (backend instanceof RemoteBackend) backend.dispose();
    };
  }, [stores, backend, hub]);

  return (
    <HubProvider hub={hub} workspace={context}>
      <StoresProvider key={context?.id ?? 'personal'} stores={stores}>
        <App />
      </StoresProvider>
    </HubProvider>
  );
}
