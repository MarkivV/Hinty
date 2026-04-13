// Global type declarations for the IPC bridge exposed via preload
interface ElectronAPI {
  send: (channel: string, ...args: unknown[]) => void;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  once: (channel: string, callback: (...args: unknown[]) => void) => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
