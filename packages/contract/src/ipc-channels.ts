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
  'agents.list',
  'agents.create',
  'agents.update',
  'agents.delete',
  'agents.duplicate',
  'settings.get',
  'settings.update',
  'conversations.list',
  'conversations.create',
  'conversations.rename',
  'conversations.archive',
  'conversations.markRead',
  'messages.list',
  'messages.send',
  'messages.cancel',
  'messages.retry',
  'dialogs.pickFolder',
] as const;

export const ipcEventChannels = [
  'runner.status',
  'conversation.updated',
  'message.updated',
  'message.delta',
  'message.block',
] as const;
