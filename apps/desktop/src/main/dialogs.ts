import { BrowserWindow, dialog } from 'electron';

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Native directory picker, attached to the focused window. */
export async function pickFolder(): Promise<string | null> {
  const opts = { properties: ['openDirectory', 'createDirectory'] } as Electron.OpenDialogOptions;
  const win = BrowserWindow.getFocusedWindow();
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
}

/** Native save dialog, attached to the focused window; null when cancelled. */
export async function pickSaveFile(
  suggestedName: string,
  filter: FileFilter,
): Promise<string | null> {
  const opts: Electron.SaveDialogOptions = { defaultPath: suggestedName, filters: [filter] };
  const win = BrowserWindow.getFocusedWindow();
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled ? null : (r.filePath ?? null);
}

/** Native open dialog for one file, attached to the focused window; null when cancelled. */
export async function pickOpenFile(filter: FileFilter): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [filter] };
  const win = BrowserWindow.getFocusedWindow();
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
}
