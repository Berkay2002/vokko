// The nameplate and display name style pickers as profile editor tiles. They stage `nameplate` / `display_name_styles` in the draft's
// `extra` fields (profile-editor/draft.ts EXTRA_FIELDS), which Save sends to PATCH /users/@me.
import { Plus } from "lucide-react";
import type { DisplayNameStyles } from "../api/types";
import { registerProfileEditorTile, type ProfileEditorTile, type ProfileEditorTileProps } from "../profile-editor/registry";
import { Tile } from "../profile-editor/tiles";
import { Nameplate, StyledName } from "./NameStyles";
import { DisplayNameStyleFields, NameplateGrid } from "./NameStylePickers";

/** The name the pickers preview: the staged display name on the main profile, else the saved one. */
const previewName = ({ user, scope, draft }: ProfileEditorTileProps): string => (scope.kind === "main" && draft.name.trim()) || user.global_name || user.username;

const NameplateTile: ProfileEditorTile = props => {
  const { user, draft, setExtra, locked, open, setOpen } = props;
  const value = typeof draft.extra.nameplate === "string" ? draft.extra.nameplate : null;
  const name = previewName(props);
  return (
    <Tile
      label="Nameplate"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      className="pe-tile-wide pe-tile-nameplate"
      panel={<NameplateGrid user={user} name={name} value={value} onChange={next => setExtra("nameplate", next)} />}
    >
      <span className={`pf-nameplate-row${value ? " has-nameplate" : ""}`}>
        <Nameplate id={value} />
        <span className="pf-nameplate-name">{name}</span>
      </span>
      {!value && <Plus size={16} className="pe-tile-plus" aria-hidden="true" />}
    </Tile>
  );
};

const isNameStyle = (value: unknown): value is DisplayNameStyles =>
  typeof value === "object" && value !== null && typeof (value as DisplayNameStyles).font_id === "string" && Array.isArray((value as DisplayNameStyles).colors);

const DisplayNameStyleTile: ProfileEditorTile = props => {
  const { draft, setExtra, locked, open, setOpen } = props;
  const value = isNameStyle(draft.extra.display_name_styles) ? draft.extra.display_name_styles : null;
  const name = previewName(props);
  return (
    <Tile
      label="Display name style"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      className="pe-tile-wide pe-tile-name-style"
      panel={<DisplayNameStyleFields name={name} value={value} onChange={next => setExtra("display_name_styles", next)} />}
    >
      <StyledName className="pf-name-sample" styles={value}>{name}</StyledName>
      {!value && <Plus size={16} className="pe-tile-plus" aria-hidden="true" />}
    </Tile>
  );
};

registerProfileEditorTile("nameplate", NameplateTile);
registerProfileEditorTile("display-name-style", DisplayNameStyleTile);
