import type {
  AgentDraft,
  AgentPatch,
  AppSettingsPatch,
  AttachmentInput,
  SearchInput,
  ApprovalDecision,
  ConnectionDraft,
  ConnectionPatch,
  ConnectionTarget,
  ConversationListInput,
  DetectBinaryInput,
  IpcInput,
  IpcInvokeChannel,
  IpcOutput,
  ToolServerDraft,
  ToolServerPatch,
  ToolServerTestTarget,
  GoogleDriveConfigureInput,
  UserContent,
  ModelPrices,
  ProviderId,
  UsageRange,
} from '@comitiva/contract';
import { BackendError, type Backend, type BackendEvent } from './Backend';

/** Backend over the preload bridge. The only module allowed to touch window.api. */
export class LocalBackend implements Backend {
  private readonly api = {
    invoke: async <C extends IpcInvokeChannel>(
      channel: C,
      input: IpcInput<C>,
    ): Promise<IpcOutput<C>> => {
      const result = await window.api.invoke(channel, input);
      if (result.ok) return result.value;
      throw new BackendError(result.error.code, result.error.message, result.error.retryable);
    },
    on: window.api.on,
  };

  app = {
    getVersion: () => this.api.invoke('app.getVersion', undefined),
  };

  runner = {
    getStatus: async () => (await this.api.invoke('runner.getStatus', undefined)).status,
  };

  secrets = {
    getStatus: () => this.api.invoke('secrets.getStatus', undefined),
  };

  connections = {
    list: () => this.api.invoke('connections.list', undefined),
    create: (draft: ConnectionDraft) => this.api.invoke('connections.create', draft),
    update: (id: string, patch: ConnectionPatch) =>
      this.api.invoke('connections.update', { id, patch }),
    delete: (id: string) => this.api.invoke('connections.delete', { id }),
    test: (target: ConnectionTarget) => this.api.invoke('connections.test', target),
    listModels: (target: ConnectionTarget) => this.api.invoke('connections.listModels', target),
    detectBinary: (input: DetectBinaryInput) => this.api.invoke('connections.detectBinary', input),
  };

  agents = {
    list: () => this.api.invoke('agents.list', undefined),
    create: (draft: AgentDraft) => this.api.invoke('agents.create', draft),
    update: (id: string, patch: AgentPatch) => this.api.invoke('agents.update', { id, patch }),
    delete: (id: string) => this.api.invoke('agents.delete', { id }),
    duplicate: (id: string, name?: string) =>
      this.api.invoke('agents.duplicate', name === undefined ? { id } : { id, name }),
  };

  settings = {
    get: () => this.api.invoke('settings.get', undefined),
    update: (patch: AppSettingsPatch) => this.api.invoke('settings.update', patch),
  };

  conversations = {
    list: (filter?: ConversationListInput) => this.api.invoke('conversations.list', filter),
    create: (agentId: string) => this.api.invoke('conversations.create', { agentId }),
    rename: (id: string, title: string) => this.api.invoke('conversations.rename', { id, title }),
    archive: (id: string, archived: boolean) =>
      this.api.invoke('conversations.archive', { id, archived }),
    markRead: (id: string) => this.api.invoke('conversations.markRead', { id }),
    exportMarkdown: (id: string) => this.api.invoke('conversations.exportMarkdown', { id }),
  };

  bundle = {
    export: (agentIds?: string[]) => this.api.invoke('bundle.export', agentIds ? { agentIds } : {}),
    import: () => this.api.invoke('bundle.import', undefined),
  };

  messages = {
    list: (conversationId: string, opts: { beforeSeq?: number; limit?: number } = {}) =>
      this.api.invoke('messages.list', { conversationId, ...opts }),
    send: (conversationId: string, content: UserContent) =>
      this.api.invoke('messages.send', { conversationId, content }),
    cancel: (conversationId: string) => this.api.invoke('messages.cancel', { conversationId }),
    retry: (conversationId: string) => this.api.invoke('messages.retry', { conversationId }),
  };

  updates = {
    getStatus: () => this.api.invoke('updates.getStatus', undefined),
    check: () => this.api.invoke('updates.check', undefined),
    install: () => this.api.invoke('updates.install', undefined),
  };

  search = {
    query: (input: SearchInput) => this.api.invoke('search.query', input),
  };

  attachments = {
    add: (input: AttachmentInput) => this.api.invoke('attachments.add', input),
    // Served by main from the attachment store (main/attachmentProtocol.ts).
    url: (path: string) => `comitiva-attachment://file/${encodeURIComponent(path)}`,
  };

  dialogs = {
    pickFolder: () => this.api.invoke('dialogs.pickFolder', undefined),
  };

  toolServers = {
    list: () => this.api.invoke('toolServers.list', undefined),
    create: (draft: ToolServerDraft) => this.api.invoke('toolServers.create', draft),
    update: (id: string, patch: ToolServerPatch) =>
      this.api.invoke('toolServers.update', { id, patch }),
    delete: (id: string) => this.api.invoke('toolServers.delete', { id }),
    test: (target: ToolServerTestTarget) => this.api.invoke('toolServers.test', target),
  };

  googleDrive = {
    getStatus: () => this.api.invoke('googleDrive.getStatus', undefined),
    configure: (input: GoogleDriveConfigureInput) =>
      this.api.invoke('googleDrive.configure', input),
    connect: () => this.api.invoke('googleDrive.connect', undefined),
    cancelConnect: () => this.api.invoke('googleDrive.cancelConnect', undefined),
    disconnect: () => this.api.invoke('googleDrive.disconnect', undefined),
  };

  approvals = {
    decide: (conversationId: string, toolUseId: string, decision: ApprovalDecision) =>
      this.api.invoke('approvals.decide', { conversationId, toolUseId, decision }),
  };

  usage = {
    summary: (range: UsageRange) => this.api.invoke('usage.summary', range),
    timeseries: (range: UsageRange) => this.api.invoke('usage.timeseries', range),
    conversation: (conversationId: string) =>
      this.api.invoke('usage.conversation', { conversationId }),
    export: (input: UsageRange & { shape?: 'records' | 'summary' }) =>
      this.api.invoke('usage.export', input),
    prices: () => this.api.invoke('usage.prices', undefined),
    setPrice: (provider: ProviderId, model: string, prices: ModelPrices) =>
      this.api.invoke('usage.setPrice', { provider, model, prices }),
    clearPrice: (provider: ProviderId, model: string) =>
      this.api.invoke('usage.clearPrice', { provider, model }),
  };

  onEvent(handler: (event: BackendEvent) => void): () => void {
    const offs = [
      this.api.on('runner.status', ({ status }) => handler({ type: 'runner.status', status })),
      this.api.on('conversation.updated', (p) => handler({ type: 'conversation.updated', ...p })),
      this.api.on('message.updated', (p) => handler({ type: 'message.updated', ...p })),
      this.api.on('message.delta', (p) => handler({ type: 'message.delta', ...p })),
      this.api.on('message.block', (p) => handler({ type: 'message.block', ...p })),
      this.api.on('updates.status', (status) => handler({ type: 'updates.status', status })),
      this.api.on('menu.command', ({ command }) => handler({ type: 'menu.command', command })),
    ];
    return () => offs.forEach((off) => off());
  }
}
