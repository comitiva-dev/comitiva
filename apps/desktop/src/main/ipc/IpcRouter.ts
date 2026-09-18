import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  AppError,
  ipcInvokeChannels,
  type IpcEventChannel,
  type IpcEventPayload,
} from '@comitiva/contract';
import { runInvoke, type InvokeHandlers } from './invoke';

/** Registers every invoke channel from the contract and broadcasts events. */
export class IpcRouter {
  constructor(
    private readonly handlers: InvokeHandlers,
    private readonly isTrustedSender: (url: string) => boolean,
  ) {}

  register(): void {
    for (const channel of ipcInvokeChannels) {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, input: unknown) => {
        if (!this.isTrustedSender(event.senderFrame?.url ?? '')) {
          return { ok: false, error: new AppError('invalid_request', 'Untrusted sender').toJSON() };
        }
        return runInvoke(channel, input, this.handlers[channel] as InvokeHandlers[typeof channel]);
      });
    }
  }

  broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }
}
