// The nameplate, display name style and profile frame pickers as profile editor tiles. They stage `nameplate` / `display_name_styles` /
// `profile_frame` in the draft's
// `extra` fields (profile-editor/draft.ts EXTRA_FIELDS), which Save sends to PATCH /users/@me.
import type { DisplayNameStyles } from "../api/types";
import { FramePicker, NameStylePicker, NameplatePicker } from "../profile-editor/pickers";
import { previewName } from "../profile-editor/previewName";
import { registerProfileEditorTile, type ProfileEditorTile } from "../profile-editor/registry";
import { Tile } from "../profile-editor/tiles";
import { Nameplate, StyledName } from "./NameStyles";
import { ProfileFrame } from "./ProfileEffect";

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

const FrameTile: ProfileEditorTile = props => {
  const { user, look, draft, setExtra, locked, open, setOpen } = props;
  const value = typeof draft.extra.profile_frame === "string" ? draft.extra.profile_frame : null;
  return (
    <Tile
      label="Profile frame"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      empty={!value}
      className="pe-tile-effect pe-tile-frame"
      modal={<FramePicker user={user} look={look} name={previewName(props)} value={value} onApply={next => setExtra("profile_frame", next)} onClose={() => setOpen(false)} />}
    >
      <span className={`pe-frame-strip${value ? "" : " pe-ph"}`}>
        <span className="pe-frame-strip-inner">
          <ProfileFrame id={value ?? "gold-filigree"} />
        </span>
      </span>
    </Tile>
  );
};

registerProfileEditorTile("nameplate", NameplateTile);
registerProfileEditorTile("profile-frame", FrameTile);
registerProfileEditorTile("display-name-style", DisplayNameStyleTile);
