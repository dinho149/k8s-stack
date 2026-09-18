import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopEvent } from './shared';
contextBridge.exposeInMainWorld(
  'dogfood',
  Object.freeze({
    call: (method: string, params: Record<string, unknown> = {}) =>
      ipcRenderer.invoke('dogfood:call', { method, params }),
    onEvent: (fn: (event: DesktopEvent) => void) => {
      const listener = (_: unknown, event: DesktopEvent) => fn(event);
      ipcRenderer.on('dogfood:event', listener);
      return () => ipcRenderer.removeListener('dogfood:event', listener);
    },
  }),
);
