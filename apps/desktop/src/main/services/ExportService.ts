import { readFile, writeFile } from 'node:fs/promises';
import {
  AppError,
  providerDescriptors,
  cliProviderDescriptors,
  type ImportReport,
} from '@comitiva/contract';
import type { AgentRepository } from '../db/repositories/AgentRepository';
import type { ConnectionRepository } from '../db/repositories/ConnectionRepository';
import type { ConversationRepository } from '../db/repositories/ConversationRepository';
import type { MessageRepository } from '../db/repositories/MessageRepository';
import type { BundleService } from './BundleService';
import { conversationMarkdown } from './exporters/markdown';

type Filter = { name: string; extensions: string[] };

export interface ExportServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  agents: AgentRepository;
  connections: ConnectionRepository;
  bundle: BundleService;
  saveFile(suggestedName: string, filter: Filter): Promise<string | null>;
  openFile(filter: Filter): Promise<string | null>;
  now?: () => Date;
}

const MARKDOWN: Filter = { name: 'Markdown', extensions: ['md'] };
const JSON_FILE: Filter = { name: 'JSON', extensions: ['json'] };

/** A file name from a title: letters, digits and dashes, at most 60 characters. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'conversation';
}

function providerLabel(provider: string): string {
  const d =
    (providerDescriptors as Record<string, { label: string } | undefined>)[provider] ??
    (cliProviderDescriptors as Record<string, { label: string } | undefined>)[provider];
  return d?.label ?? provider;
}

/** Writes conversations and bundles through the native dialogs, and reads bundles back. */
export class ExportService {
  private readonly now: () => Date;

  constructor(private readonly deps: ExportServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The saved path, or null when the dialog was cancelled. */
  async conversationMarkdown(id: string): Promise<string | null> {
    const conversation = this.deps.conversations.require(id);
    const agent = this.deps.agents.require(conversation.agentId);
    const connection = this.deps.connections.get(agent.connectionId)?.connection;
    const model = connection
      ? [providerLabel(connection.provider), agent.model ?? connection.config.defaultModel]
          .filter(Boolean)
          .join(' · ')
      : null;
    const text = conversationMarkdown({
      conversation,
      agentName: agent.name,
      model,
      messages: this.deps.messages.all(id),
      exportedAt: this.now().toISOString(),
    });
    const path = await this.deps.saveFile(
      `${fileSlug(conversation.title ?? agent.name)}.md`,
      MARKDOWN,
    );
    if (!path) return null;
    await this.write(path, text);
    return path;
  }

  async exportBundle(agentIds?: readonly string[]): Promise<string | null> {
    const bundle = this.deps.bundle.export(agentIds);
    const day = this.now().toISOString().slice(0, 10);
    const path = await this.deps.saveFile(`comitiva-agents-${day}.json`, JSON_FILE);
    if (!path) return null;
    await this.write(path, `${JSON.stringify(bundle, null, 2)}\n`);
    return path;
  }

  async importBundle(): Promise<ImportReport | null> {
    const path = await this.deps.openFile(JSON_FILE);
    if (!path) return null;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      throw new AppError('invalid_request', `Could not read ${path}`, { cause: err });
    }
    return this.deps.bundle.import(text);
  }

  private async write(path: string, text: string): Promise<void> {
    try {
      await writeFile(path, text, 'utf8');
    } catch (err) {
      throw new AppError('internal', `Could not write ${path}`, { cause: err });
    }
  }
}
