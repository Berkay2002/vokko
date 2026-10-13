import type { ReactNode } from "react";
import { Ban } from "lucide-react";
import type { User } from "../api/types";
import { ProfileBanner } from "../perks/ProfileBanner";
import { ProfileEffect } from "../perks/ProfileEffect";
import { themeVars, type ProfileLook } from "../perks/profile";
import { Avatar } from "../shell/Avatar";
import { Modal } from "../ui";

/**
 * The shell of every picker modal opened from a left-column tile (effect, decoration, nameplate, display name style): a title row,
 * a scrollable choice grid on the left, a live preview with an info box on the right, and Cancel / Apply. Apply stays disabled until
 * the selection differs from the saved value; the picker's content (`grid`, `preview`) is supplied per customisation.
 */
export function PickerModal({ title, onClose, onApply, canApply, grid, preview, info, className }: {
  title: string;
  onClose(): void;
  /** Stage the selection; the shell closes afterwards. */
  onApply(): void;
  canApply: boolean;
  grid: ReactNode;
  preview: ReactNode;
  /** Selected item: its name and a line about it. */
  info?: { name: string; description: string };
  className?: string;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      className={`pe-picker${className ? ` ${className}` : ""}`}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canApply}
            onClick={() => {
              onApply();
              onClose();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="pe-pk-body">
        <div className="pe-pk-choices">{grid}</div>
        <div className="pe-pk-side">
          {preview}
          {info && (
            <div className="pe-pk-info">
              <strong>{info.name}</strong>
              <p>{info.description}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A headed group of choices. `layout` sets the column count: squares (3), rows (1) or compact samples (4). */
export function PickerSection({ title, label, layout = "squares", children }: { title: string; label?: string; layout?: "squares" | "rows" | "samples"; children: ReactNode }) {
  return (
    <section className="pe-pk-section">
      <h3 className="pe-pk-heading">{title}</h3>
      <div className={`pe-pk-grid ${layout}`} role="radiogroup" aria-label={label ?? title}>
        {children}
      </div>
    </section>
  );
}

export function PickerTile({ selected, label, onClick, className, children }: { selected: boolean; label: string; onClick(): void; className?: string; children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={label} title={label} className={`pe-pk-tile${selected ? " selected" : ""}${className ? ` ${className}` : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

/** The "None" choice that opens every "Your ..." section. */
export function NoneTile({ selected, onClick, className }: { selected: boolean; onClick(): void; className?: string }) {
  return (
    <PickerTile selected={selected} label="None" onClick={onClick} className={className}>
      <span className="pe-pk-none">
        <Ban size={28} aria-hidden="true" />
        None
      </span>
    </PickerTile>
  );
}

/** A miniature profile card (banner, avatar, name, a button) for the pickers that change how the card looks. */
export function PreviewCard({ user, look, name, nameNode }: { user: Pick<User, "id" | "username">; look: ProfileLook; name: string; nameNode?: ReactNode }) {
  return (
    <div className={`pe-pk-card${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)} data-testid="pe-picker-card">
      <ProfileBanner look={{ ...look, effect: null }} className="pe-pk-card-banner" />
      <div className="pe-pk-card-avatar">
        <Avatar user={{ id: user.id, avatar: look.avatar }} size={72} decoration={look.decoration ?? false} status />
      </div>
      <div className="pe-pk-card-body">
        <div className="pe-pk-card-name">{nameNode ?? name}</div>
        <div className="pe-pk-card-user">{user.username}</div>
        <span className="btn pe-pk-card-btn" aria-hidden="true">
          Example button
        </span>
      </div>
      <ProfileEffect id={look.effect} />
    </div>
  );
}
