import { describe, expect, it } from 'vitest';
import { COMMANDS, SHORTCUTS, commandFor, displayKeys, isCommand, matches } from './shortcuts';

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('maps Ctrl on Linux and Windows, Cmd on macOS, with exact modifiers', () => {
    expect(commandFor(key('k', { ctrlKey: true }), false)).toBe('quickSwitcher');
    expect(commandFor(key('k', { metaKey: true }), true)).toBe('quickSwitcher');
    expect(commandFor(key('k', { metaKey: true }), false)).toBeNull();
    expect(commandFor(key('k', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(commandFor(key('E', { ctrlKey: true, shiftKey: true }), false)).toBe(
      'exportConversation',
    );
    expect(commandFor(key('ArrowDown', { altKey: true }), false)).toBe('nextConversation');
    expect(commandFor(key(',', { ctrlKey: true }), false)).toBe('settings');
    expect(commandFor(key('3', { ctrlKey: true }), false)).toBe('goTools');
    expect(matches('CmdOrCtrl+/', key('/', { ctrlKey: true }), false)).toBe(true);
  });

  it('has one binding per key and per command', () => {
    expect(new Set(SHORTCUTS.map((s) => s.keys)).size).toBe(SHORTCUTS.length);
    expect(new Set(SHORTCUTS.map((s) => s.command)).size).toBe(SHORTCUTS.length);
    expect(SHORTCUTS.every((s) => isCommand(s.command))).toBe(true);
    expect(isCommand('rm -rf')).toBe(false);
    expect(COMMANDS).toContain('checkForUpdates');
  });

  it('shows keys the platform way', () => {
    expect(displayKeys('CmdOrCtrl+Shift+E', true)).toEqual(['⌘', '⇧', 'E']);
    expect(displayKeys('CmdOrCtrl+Shift+E', false)).toEqual(['Ctrl', 'Shift', 'E']);
    expect(displayKeys('Alt+Up', false)).toEqual(['Alt', '↑']);
  });
});
