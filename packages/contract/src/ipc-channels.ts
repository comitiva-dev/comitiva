/**
 * IPC channel names as plain data, with no zod import, so the sandboxed
 * preload can allowlist them without bundling schemas. Published as the
 * `@comitiva/contract/ipc-channels` subpath; a test keeps these lists in sync
 * with the schemas in ipc.ts.
 */
export const ipcInvokeChannels = [
  'app.getVersion',
  'runner.getStatus',
  'secrets.getStatus',
  'connections.list',
  'connections.create',
  'connections.update',
  'connections.delete',
  'connections.test',
  'connections.listModels',
  'connections.detectBinary',
  'dialogs.pickFolder',
] as const;

export const ipcEventChannels = ['runner.status'] as const;
