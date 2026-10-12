import type { ComponentType } from "react";
import type { User } from "../api/types";
import type { ProfileLook } from "../perks/profile";
import type { ProfileDraft, Scope } from "./draft";

/** Props every tile of the editor's left column receives. */
export interface ProfileEditorTileProps {
  user: User;
  scope: Scope;
  draft: ProfileDraft;
  /** The profile as the live card shows it right now (staged values included). */
  look: ProfileLook;
  /** Change core draft fields. */
  setDraft(patch: Partial<ProfileDraft>): void;
  /** Stage a value of a user field the editor has no typed draft slot for (sent as that PATCH /users/@me key on Save). */
  setExtra(field: string, value: unknown): void;
  /** The tile belongs to the main profile only and the editor is on a server profile. */
  locked: boolean;
  /** Upload target channel for image fields (null while no channel is known). */
  uploadChannel: string | null;
  /** The tile's inline panel is expanded. */
  open: boolean;
  setOpen(open: boolean): void;
}

export type ProfileEditorTile = ComponentType<ProfileEditorTileProps>;

/** Tile ids in layout order. `registerProfileEditorTile(id, Component)` replaces the built-in tile of that id. */
export const PROFILE_EDITOR_TILE_IDS = [
  "nameplate",
  "avatar",
  "avatar-decoration",
  "banner-color",
  "profile-effect",
  "profile-frame",
  "display-name-style",
  "profile-theme",
  "profile-banner",
  "animated-avatar",
] as const;

export type ProfileEditorTileId = (typeof PROFILE_EDITOR_TILE_IDS)[number];

const registered = new Map<string, ProfileEditorTile>();
const builtin = new Map<string, ProfileEditorTile>();

/** Plug a picker into the editor: `registerProfileEditorTile("nameplate", NameplatePicker)`. Returns an unregister function. */
export function registerProfileEditorTile(id: string, component: ProfileEditorTile): () => void {
  registered.set(id, component);
  return () => {
    if (registered.get(id) === component) registered.delete(id);
  };
}

/** The editor's own tiles (registered by tiles.tsx); a tile registered through `registerProfileEditorTile` wins over them. */
export function registerBuiltinTile(id: string, component: ProfileEditorTile): void {
  builtin.set(id, component);
}

/** The tile for `id`, or `fallback` (the "coming soon" tile) when neither a picker nor a built-in exists. */
export function resolveProfileEditorTile(id: string, fallback: ProfileEditorTile): ProfileEditorTile {
  return registered.get(id) ?? builtin.get(id) ?? fallback;
}

export function hasProfileEditorTile(id: string): boolean {
  return registered.has(id) || builtin.has(id);
}

/** Test hook: drop every registration. */
export function resetProfileEditorTiles(): void {
  registered.clear();
  builtin.clear();
}
