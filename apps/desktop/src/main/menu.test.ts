import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { COMMANDS } from '../shared/shortcuts';
import { menuTemplate } from './menu';

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? items(i.submenu) : [])]);
}

const deps = (mac: boolean, dev = false) => ({
  mac,
  dev,
  t: (k: string) => `T(${k})`,
  send: vi.fn(),
  openExternal: vi.fn(),
});

describe('menuTemplate', () => {
  it('offers every command once, labelled through i18n, and sends it to the renderer', () => {
    for (const mac of [true, false]) {
      const d = deps(mac);
      const all = items(menuTemplate(d));
      for (const c of COMMANDS) {
        const found = all.filter((i) => i.id === c);
        expect(found, `${c} on ${mac ? 'mac' : 'other'}`).toHaveLength(1);
        expect(found[0]!.label).toBe(`T(commands.${c})`);
      }
      (all.find((i) => i.id === 'quickSwitcher')!.click as () => void)();
      expect(d.send).toHaveBeenCalledWith('quickSwitcher');
    }
  });

  it('shows keys everywhere but registers them only on macOS', () => {
    const linux = items(menuTemplate(deps(false))).find((i) => i.id === 'quickSwitcher')!;
    expect(linux).toMatchObject({ accelerator: 'CmdOrCtrl+K', registerAccelerator: false });
    const mac = items(menuTemplate(deps(true))).find((i) => i.id === 'quickSwitcher')!;
    expect(mac).toMatchObject({ accelerator: 'CmdOrCtrl+K', registerAccelerator: true });
  });

  it('has the app menu on macOS only, and developer tools in development only', () => {
    expect(menuTemplate(deps(true))[0]!.label).toBe('Comitiva');
    expect(menuTemplate(deps(false))[0]!.label).toBe('T(main.menu.file)');
    const roles = (dev: boolean) => items(menuTemplate(deps(false, dev))).map((i) => i.role);
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('toggleDevTools');
  });

  it('opens the project pages in the browser', () => {
    const d = deps(false);
    const doc = items(menuTemplate(d)).find((i) => i.label === 'T(main.menu.documentation)')!;
    (doc.click as () => void)();
    expect(d.openExternal).toHaveBeenCalledWith('https://github.com/comitiva-dev/comitiva#readme');
  });
});
