// Progress of the new-server checklist, per guild, kept in localStorage (a convenience: losing it only brings the card back).
import { create } from "zustand";
import type { Snowflake } from "../api/types";

export interface WelcomeProgress {
  invited?: boolean;
  personalized?: boolean;
  app?: boolean;
  dismissed?: boolean;
}

const KEY = (guildId: Snowflake) => `vokko.welcome.${guildId}`;

function read(guildId: Snowflake): WelcomeProgress {
  try {
    const raw = localStorage.getItem(KEY(guildId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as WelcomeProgress) : {};
  } catch {
    return {};
  }
}

interface WelcomeStore {
  progress: Record<Snowflake, WelcomeProgress>;
  mark(guildId: Snowflake, change: WelcomeProgress): void;
}

export const useWelcome = create<WelcomeStore>()((set, get) => ({
  progress: {},
  mark(guildId, change) {
    const next = { ...(get().progress[guildId] ?? read(guildId)), ...change };
    set({ progress: { ...get().progress, [guildId]: next } });
    try {
      localStorage.setItem(KEY(guildId), JSON.stringify(next));
    } catch {
      /* private mode */
    }
  },
}));

/** Subscribes to a guild's progress (stored value until the first change in this session). */
export function useWelcomeProgress(guildId: Snowflake): WelcomeProgress {
  const live = useWelcome(s => s.progress[guildId]);
  return live ?? read(guildId);
}

/** Servers newer than this still get the checklist. */
export const NEW_SERVER_DAYS = 14;

/** Whether the checklist is offered at all: the owner of a server that was created recently. */
export function isNewServerOwner(guildCreatedAt: number, ownerId: Snowflake, meId: Snowflake | undefined, now = Date.now()): boolean {
  return ownerId === meId && now - guildCreatedAt < NEW_SERVER_DAYS * 24 * 60 * 60 * 1000;
}
