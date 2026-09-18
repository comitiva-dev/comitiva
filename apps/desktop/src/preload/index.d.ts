import type { DesktopApi } from '@comitiva/contract';

declare global {
  interface Window {
    api: DesktopApi;
  }
}
