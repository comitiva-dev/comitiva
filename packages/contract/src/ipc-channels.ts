/**
 * IPC channel names as plain data, with no zod import, so the sandboxed
 * preload can allowlist them without bundling schemas. Published as the
 * `@comitiva/contract/ipc-channels` subpath; a test keeps these lists in sync
 * with the schemas in ipc.ts.
 */
export const ipcInvokeChannels = [
  'app.getVersion',
  'runner.getStatus',
  'spike.getState',
  'spike.saveApiKey',
  'spike.testApiKey',
  'spike.send',
  'spike.cancel',
  'spike.reset',
  'spike.reportLatency',
] as const;

export const ipcEventChannels = ['spike.event', 'runner.status'] as const;
