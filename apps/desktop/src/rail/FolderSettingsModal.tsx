import { useState } from "react";
import { Check } from "lucide-react";
import type { GuildFolder } from "../api/types";
import { Modal } from "../ui";

/** Folder colours offered in the settings (RGB ints); `null` is the default tint. */
export const FOLDER_COLORS: number[] = [0x5865f2, 0x3ba55c, 0xfaa61a, 0xed4245, 0xeb459e, 0x9b59b6, 0x1abc9c, 0x3498db, 0xe67e22, 0x95a5a6];

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

export function FolderSettingsModal({ folder, guildNames, onClose, onSave }: { folder: GuildFolder; guildNames: string[]; onClose: () => void; onSave: (patch: Pick<GuildFolder, "name" | "color">) => void }) {
  const [name, setName] = useState(folder.name ?? "");
  const [color, setColor] = useState<number | null>(folder.color);
  const submit = () => onSave({ name: name.trim() || null, color });
  return (
    <Modal
      open
      onClose={onClose}
      title="Folder Settings"
      footer={
        <button type="button" className="btn btn-primary" onClick={submit}>
          Done
        </button>
      }
    >
      <label className="field-label" htmlFor="folder-name">
        Folder Name
      </label>
      <input id="folder-name" className="input" value={name} maxLength={32} placeholder={guildNames.join(", ")} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
      <div className="field-label folder-color-label" id="folder-color-label">
        Folder Colour
      </div>
      <div className="folder-colors" role="radiogroup" aria-labelledby="folder-color-label">
        {[null, ...FOLDER_COLORS].map(option => (
          <button
            key={option ?? "default"}
            type="button"
            role="radio"
            aria-checked={color === option}
            aria-label={option === null ? "Default colour" : hex(option)}
            className={`folder-swatch${option === null ? " folder-swatch-default" : ""}`}
            style={option === null ? undefined : { background: hex(option) }}
            onClick={() => setColor(option)}
          >
            {color === option && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
