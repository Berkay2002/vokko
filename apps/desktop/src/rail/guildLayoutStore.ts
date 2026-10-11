// The user's guild layout (folders and rail order): from READY, kept current by GUILD_LAYOUT_UPDATE, saved with PATCH.

import { create } from "zustand";
import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import type { UpdateGuildLayoutRequest, GuildLayout } from "../api/types";
import { EMPTY_SETTINGS } from "./railOrder";

interface SettingsState {
  settings: GuildLayout;
}

export const guildLayoutStore = create<SettingsState>()(() => ({ settings: EMPTY_SETTINGS }));

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", ready => guildLayoutStore.setState({ settings: ready.guild_layout ?? EMPTY_SETTINGS }));
  gateway.on("GUILD_LAYOUT_UPDATE", settings => guildLayoutStore.setState({ settings }));
}
wire();

let saveSeq = 0;

/** Applies `patch` at once and saves it. Only the newest save's outcome lands: its response, or on failure the server's
 * current layout (re-fetched), so overlapping saves never roll back to a stale snapshot. */
export async function saveGuildLayout(patch: UpdateGuildLayoutRequest): Promise<void> {
  const seq = ++saveSeq;
  guildLayoutStore.setState(state => ({ settings: { ...state.settings, ...patch } }));
  try {
    const saved = await request<GuildLayout>("PATCH", "/users/@me/guild-layout", patch);
    if (seq === saveSeq) guildLayoutStore.setState({ settings: saved });
  } catch (error) {
    if (seq === saveSeq) {
      const current = await request<GuildLayout>("GET", "/users/@me/guild-layout").catch(() => null);
      if (current && seq === saveSeq) guildLayoutStore.setState({ settings: current });
    }
    throw error;
  }
}
