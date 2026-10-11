import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Snapshot } from './protocol';

export const desktopAvailable = isTauri();

export async function dispatch(command: string, params: Record<string, unknown> = {}): Promise<Snapshot> {
  if (!desktopAvailable) throw new Error('Open the desktop app to use local messaging.');
  return invoke<Snapshot>('dispatch', { request: { command, params } });
}
