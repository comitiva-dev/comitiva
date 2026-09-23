/**
 * Keyboard shortcuts and the commands they run: one list for the native menu
 * (main), the key handler and the shortcuts dialog (renderer). Plain data
 * and pure functions only, so both processes import it.
 *
 * Keys use Electron's accelerator syntax. On Linux and Windows the renderer
 * handles every shortcut and the menu only shows them (registerAccelerator:
 * false), so a key never fires twice; on macOS the menu owns its key
 * equivalents, as the platform expects.
 */

export const COMMANDS = [
  'quickSwitcher',
  'newConversation',
  'previousConversation',
  'nextConversation',
  'exportConversation',
  'attach',
  'goAgents',
  'goConnections',
  'goTools',
  'goUsage',
  'settings',
  'shortcuts',
  'exportAll',
  'importBundle',
  'checkForUpdates',
] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(value: unknown): value is Command {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

export type ShortcutGroup = 'navigation' | 'conversation' | 'app';

export interface Shortcut {
  command: Command;
  keys: string;
  group: ShortcutGroup;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { command: 'quickSwitcher', keys: 'CmdOrCtrl+K', group: 'navigation' },
  { command: 'previousConversation', keys: 'Alt+Up', group: 'navigation' },
  { command: 'nextConversation', keys: 'Alt+Down', group: 'navigation' },
  { command: 'goAgents', keys: 'CmdOrCtrl+1', group: 'navigation' },
  { command: 'goConnections', keys: 'CmdOrCtrl+2', group: 'navigation' },
  { command: 'goTools', keys: 'CmdOrCtrl+3', group: 'navigation' },
  { command: 'goUsage', keys: 'CmdOrCtrl+4', group: 'navigation' },
  { command: 'settings', keys: 'CmdOrCtrl+,', group: 'navigation' },
  { command: 'newConversation', keys: 'CmdOrCtrl+N', group: 'conversation' },
  { command: 'attach', keys: 'CmdOrCtrl+Shift+A', group: 'conversation' },
  { command: 'exportConversation', keys: 'CmdOrCtrl+Shift+E', group: 'conversation' },
  { command: 'shortcuts', keys: 'CmdOrCtrl+/', group: 'app' },
];

/** Keys the composer handles itself; listed in the dialog, not bound globally. */
export const COMPOSER_KEYS = [
  { id: 'send', keys: 'Enter' },
  { id: 'newline', keys: 'Shift+Enter' },
  { id: 'stop', keys: 'Escape' },
] as const;

export function shortcutFor(command: Command): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.command === command);
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const KEY_NAMES: Record<string, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Esc: 'Escape',
};

function parse(keys: string) {
  const parts = keys.split('+');
  const key = parts.pop()!;
  return {
    key: KEY_NAMES[key] ?? key,
    cmdOrCtrl: parts.includes('CmdOrCtrl'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
  };
}

/** Whether a key event is this shortcut, with exactly its modifiers. */
export function matches(keys: string, e: KeyEventLike, mac: boolean): boolean {
  const s = parse(keys);
  const primary = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (primary !== s.cmdOrCtrl || other || e.shiftKey !== s.shift || e.altKey !== s.alt)
    return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}

/** The shortcut a key event is, if any. */
export function commandFor(e: KeyEventLike, mac: boolean): Command | null {
  return SHORTCUTS.find((s) => matches(s.keys, e, mac))?.command ?? null;
}

/** Keys as a person reads them on this platform: ["⌘", "K"] or ["Ctrl", "K"]. */
export function displayKeys(keys: string, mac: boolean): string[] {
  const names: Record<string, string> = mac
    ? { CmdOrCtrl: '⌘', Shift: '⇧', Alt: '⌥', Up: '↑', Down: '↓', Enter: '↩', Escape: 'Esc' }
    : {
        CmdOrCtrl: 'Ctrl',
        Shift: 'Shift',
        Alt: 'Alt',
        Up: '↑',
        Down: '↓',
        Enter: 'Enter',
        Escape: 'Esc',
      };
  return keys.split('+').map((k) => names[k] ?? k);
}
