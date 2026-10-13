import type { ProfileEditorTileProps } from "./registry";

/** The name the pickers preview: the staged display name on the main profile, else the saved one. */
export const previewName = ({ user, scope, draft }: ProfileEditorTileProps): string => (scope.kind === "main" && draft.name.trim()) || user.global_name || user.username;
