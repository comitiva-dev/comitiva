import { isAbsolute, join } from 'node:path';
import type { Connection } from '@comitiva/contract';

/**
 * Where a CLI harness runs for a conversation: the connection's working
 * directory when set, else `<workspaces>/<conversationId>`. (Phase 5 puts
 * the agent's first readwrite root ahead of both.) API connections have none.
 * ConversationService sends it as `run.start.workingDirectory` (Phase 4).
 */
export function resolveWorkingDirectory(
  connection: Connection,
  conversationId: string,
  workspacesDir: string,
): string | undefined {
  if (connection.kind !== 'cli') return undefined;
  const configured = connection.config.workingDirectory?.trim();
  if (configured && isAbsolute(configured)) return configured;
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) {
    throw new Error(`Unsafe conversation id for a directory name: ${conversationId}`);
  }
  return join(workspacesDir, conversationId);
}
