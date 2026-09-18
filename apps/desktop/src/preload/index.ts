import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi } from '@comitiva/contract';
import { ipcEventChannels, ipcInvokeChannels } from '@comitiva/contract/ipc-channels';

const invokeChannels = new Set<string>(ipcInvokeChannels);
const eventChannels = new Set<string>(ipcEventChannels);

/** Typed, allowlisted bridge. The renderer reaches it only via LocalBackend. */
const api: DesktopApi = {
  invoke(channel, input) {
    if (!invokeChannels.has(channel)) throw new Error(`Unknown channel ${channel}`);
    return ipcRenderer.invoke(channel, input);
  },
  on(channel, handler) {
    if (!eventChannels.has(channel)) throw new Error(`Unknown event channel ${channel}`);
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
