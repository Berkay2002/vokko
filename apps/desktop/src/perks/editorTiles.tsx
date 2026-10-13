// The nameplate and display name style pickers as profile editor tiles. They stage `nameplate` / `display_name_styles` in the draft's
// `extra` fields (profile-editor/draft.ts EXTRA_FIELDS), which Save sends to PATCH /users/@me.
import type { DisplayNameStyles } from "../api/types";
import { NameStylePicker, NameplatePicker } from "../profile-editor/pickers";
import { previewName } from "../profile-editor/previewName";
import { registerProfileEditorTile, type ProfileEditorTile } from "../profile-editor/registry";
import { Tile } from "../profile-editor/tiles";
import { Nameplate, StyledName } from "./NameStyles";

const NameplateTile: ProfileEditorTile = props => {
  const { user, look, draft, setExtra, locked, open, setOpen } = props;
  const value = typeof draft.extra.nameplate === "string" ? draft.extra.nameplate : null;
  const name = previewName(props);
  return (
    <Tile
      label="Nameplate"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      empty={!value}
      className="pe-tile-wide pe-tile-nameplate"
      modal={<NameplatePicker user={user} look={look} name={name} value={value} onApply={next => setExtra("nameplate", next)} onClose={() => setOpen(false)} />}
    >
      {value ? (
        <span className="pf-nameplate-row has-nameplate">
          <Nameplate id={value} />
          <span className="pf-nameplate-name">{name}</span>
        </span>
      ) : (
        <span className="pe-ph-bar" />
      )}
    </Tile>
  );
};

const isNameStyle = (value: unknown): value is DisplayNameStyles =>
  typeof value === "object" && value !== null && typeof (value as DisplayNameStyles).font_id === "string" && Array.isArray((value as DisplayNameStyles).colors);

const DisplayNameStyleTile: ProfileEditorTile = props => {
  const { user, look, draft, setExtra, locked, open, setOpen } = props;
  const value = isNameStyle(draft.extra.display_name_styles) ? draft.extra.display_name_styles : null;
  const name = previewName(props);
  return (
    <Tile
      label="Display name style"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      empty={!value}
      className="pe-tile-wide pe-tile-name-style"
      modal={
        <NameStylePicker
          user={user}
          look={look}
          name={name}
          nameplate={typeof draft.extra.nameplate === "string" ? draft.extra.nameplate : null}
          value={value}
          onApply={next => setExtra("display_name_styles", next)}
          onClose={() => setOpen(false)}
        />
      }
    >
      {value ? <StyledName className="pf-name-sample" styles={value}>{name}</StyledName> : <span className="pe-ph-bar" />}
    </Tile>
  );
};

registerProfileEditorTile("nameplate", NameplateTile);
registerProfileEditorTile("display-name-style", DisplayNameStyleTile);
