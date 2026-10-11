// Runs keybinds: the user's list is laid over the shortcut table (src/keyboard, whose dispatcher handles key presses), and binds marked
// global are registered with the OS (desktop only) so they fire while Vokko is in the background. Imported once by main.tsx.

import { isDesktop, onShortcut, registerShortcut, unregisterShortcut } from "../desktop";
import { applyKeybinds, effectiveKeybinds, runKeybindAction, toAccelerator } from "./keybinds";
import { getPrefs, usePrefs, type KeybindPref } from "./prefs";

/** OS-wide shortcut ids currently registered by this module → the action they run. */
const registered = new Map<string, string>();
let syncing: Promise<void> = Promise.resolve();

async function syncGlobal(binds: readonly KeybindPref[]): Promise<void> {
  for (const id of registered.keys()) await unregisterShortcut(id).catch(() => undefined);
  registered.clear();
  let n = 0;
  for (const bind of effectiveKeybinds(binds)) {
    if (!bind.global) continue;
    const accelerator = toAccelerator(bind.keys);
    if (!accelerator) continue;
    const id = `keybind-${(n += 1)}`;
    try {
      await registerShortcut(id, accelerator);
      registered.set(id, bind.action);
    } catch (error) {
      console.warn(`[keybinds] ${bind.keys} could not be registered globally`, error);
    }
  }
}

let wired = false;

export function wireKeybinds(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  let last = getPrefs().keybinds;
  applyKeybinds(last);
  const desktop = isDesktop();
  if (desktop) {
    void onShortcut(event => {
      const action = registered.get(event.id);
      if (action && event.state === "pressed") runKeybindAction(action);
    });
    syncing = syncGlobal(last);
  }
  usePrefs.subscribe(prefs => {
    if (prefs.keybinds === last) return;
    last = prefs.keybinds;
    applyKeybinds(last);
    if (desktop) syncing = syncing.then(() => syncGlobal(last));
  });
}

wireKeybinds();
