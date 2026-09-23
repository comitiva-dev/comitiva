import type { MenuItemConstructorOptions } from 'electron';
import { shortcutFor, type Command } from '../shared/shortcuts';

export const REPO_URL = 'https://github.com/comitiva-dev/comitiva';

export interface MenuDeps {
  mac: boolean;
  /** Reload and developer tools are for development only. */
  dev: boolean;
  t: (key: string) => string;
  /** Runs a command in the renderer (menu.command). */
  send: (command: Command) => void;
  openExternal: (url: string) => void;
}

/**
 * The native menu. Commands go to the renderer; their keys come from the
 * shared shortcuts. Outside macOS the renderer handles the keys, so the menu
 * only shows them (see shared/shortcuts.ts).
 */
export function menuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const { mac, dev, t, send } = deps;
  const command = (id: Command): MenuItemConstructorOptions => {
    const shortcut = shortcutFor(id);
    return {
      id,
      label: t(`commands.${id}`),
      click: () => send(id),
      ...(shortcut ? { accelerator: shortcut.keys, registerAccelerator: mac } : {}),
    };
  };
  const sep: MenuItemConstructorOptions = { type: 'separator' };

  const app: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: 'Comitiva',
          submenu: [
            { role: 'about', label: t('main.menu.about') },
            command('checkForUpdates'),
            sep,
            command('settings'),
            sep,
            { role: 'services' },
            sep,
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            sep,
            { role: 'quit', label: t('main.menu.quit') },
          ],
        },
      ]
    : [];

  return [
    ...app,
    {
      label: t('main.menu.file'),
      submenu: [
        command('newConversation'),
        command('attach'),
        command('exportConversation'),
        sep,
        command('importBundle'),
        command('exportAll'),
        ...(mac
          ? []
          : [sep, command('settings'), sep, { role: 'quit' as const, label: t('main.menu.quit') }]),
      ],
    },
    {
      label: t('main.menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: t('main.menu.view'),
      submenu: [
        command('quickSwitcher'),
        sep,
        command('goAgents'),
        command('goConnections'),
        command('goTools'),
        command('goUsage'),
        sep,
        command('previousConversation'),
        command('nextConversation'),
        sep,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
        ...(dev ? [sep, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu', label: t('main.menu.window') },
    {
      role: 'help',
      label: t('main.menu.help'),
      submenu: [
        command('shortcuts'),
        sep,
        {
          label: t('main.menu.documentation'),
          click: () => deps.openExternal(`${REPO_URL}#readme`),
        },
        { label: t('main.menu.releases'), click: () => deps.openExternal(`${REPO_URL}/releases`) },
        {
          label: t('main.menu.reportIssue'),
          click: () => deps.openExternal(`${REPO_URL}/issues/new`),
        },
        ...(mac
          ? []
          : [
              sep,
              command('checkForUpdates'),
              { role: 'about' as const, label: t('main.menu.about') },
            ]),
      ],
    },
  ];
}
