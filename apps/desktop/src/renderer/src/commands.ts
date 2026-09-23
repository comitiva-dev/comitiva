import type { Command } from '../../shared/shortcuts';
import { openConversation } from './lib/chat';
import type { Stores } from './store/context';

/** Whether this is a Mac (Cmd instead of Ctrl). */
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The conversation after (or before) `current` in the list, wrapping; null with none. */
export function adjacent(
  ids: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return delta === 1 ? ids[0]! : ids.at(-1)!;
  return ids[(at + delta + ids.length) % ids.length]!;
}

/**
 * Runs a command from a shortcut or the native menu. Commands about the open
 * conversation do nothing when there is none.
 */
export function runCommand(stores: Stores, command: Command): void {
  const app = stores.app.getState();
  const ui = stores.ui.getState();
  const agentId = stores.agents.getState().selectedId;
  const conversations = stores.conversations.getState();
  const open = agentId
    ? openConversation(
        conversations.selectedByAgent[agentId],
        conversations.idsByAgent[agentId] ?? [],
      )
    : null;
  const inChat = app.section === 'agents' && agentId !== null;

  switch (command) {
    case 'quickSwitcher':
      return ui.toggleQuickSwitcher();
    case 'shortcuts':
      return ui.setShortcutsOpen(!ui.shortcutsOpen);
    case 'settings':
      return app.setSection('settings');
    case 'goAgents':
      return app.setSection('agents');
    case 'goConnections':
      return app.setSection('connections');
    case 'goTools':
      return app.setSection('tools');
    case 'goUsage':
      return app.setSection('usage');
    case 'newConversation':
      if (!agentId) return;
      app.setSection('agents');
      return conversations.select(agentId, null);
    case 'previousConversation':
    case 'nextConversation': {
      if (!agentId) return;
      const next = adjacent(
        conversations.idsByAgent[agentId] ?? [],
        open,
        command === 'nextConversation' ? 1 : -1,
      );
      if (next) {
        app.setSection('agents');
        conversations.select(agentId, next);
      }
      return;
    }
    case 'exportConversation':
      if (inChat && open) void stores.transfer.getState().exportConversation(open);
      return;
    case 'attach':
      if (inChat) ui.requestAttach();
      return;
    case 'exportAll':
      return void stores.transfer.getState().exportAgents();
    case 'importBundle':
      return void stores.transfer.getState().importBundle();
    case 'checkForUpdates':
      return app.setSection('settings');
  }
}
