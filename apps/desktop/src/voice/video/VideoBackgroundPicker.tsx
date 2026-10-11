// "Video Background" grid: None, Blur (light / strong), built-in images, the user's own uploads and an upload tile.
// Used by the camera preview modal and by User Settings > Voice & Video > Camera. Where WebGL 2 is missing everything but
// "None" is disabled and the tooltip says why (the segmenter cannot run).

import { useEffect, useRef } from "react";
import { Ban, Plus, X } from "lucide-react";
import { Tooltip } from "../../ui";
import { BUILTIN_BACKGROUNDS, serializeBackground, svgDataUrl, type BackgroundChoice } from "./backgrounds";
import { useBackgrounds } from "./backgroundStore";
import { BACKGROUND_UNSUPPORTED_NOTE, supportsVideoBackground } from "./processor";
import "./video.css";

interface Props {
  /** Serialised choice (prefs.videoBackground). */
  value: string;
  onChange(next: string): void;
  /** Why the picture could not be processed with the current choice. */
  error?: string | null;
}

export function VideoBackgroundPicker({ value, onChange, error }: Props) {
  const { items, error: libraryError, load, add, remove } = useBackgrounds();
  const file = useRef<HTMLInputElement>(null);
  const supported = supportsVideoBackground();
  useEffect(() => void load(), [load]);

  const pick = (choice: BackgroundChoice) => onChange(serializeBackground(choice));
  const tile = (id: string, label: string, content: React.ReactNode, choice: BackgroundChoice, extra?: React.ReactNode) => {
    const serial = serializeBackground(choice);
    const disabled = !supported && choice.kind !== "none";
    const button = (
      <button type="button" role="radio" aria-checked={value === serial} aria-label={label} disabled={disabled} data-background={serial} className={`vbg-tile${value === serial ? " selected" : ""}`} onClick={() => pick(choice)}>
        {content}
      </button>
    );
    return (
      <div key={id} className="vbg-cell">
        <Tooltip content={disabled ? BACKGROUND_UNSUPPORTED_NOTE : label} side="top">
          {disabled ? <span className="vbg-disabled-wrap">{button}</span> : button}
        </Tooltip>
        {extra}
      </div>
    );
  };

  return (
    <div className="vbg">
      <div className="vbg-grid" role="radiogroup" aria-label="Video background">
        {tile("none", "None", <Ban size={22} aria-hidden="true" />, { kind: "none" })}
        {tile("blur-light", "Blur", <span className="vbg-blur light" aria-hidden="true" />, { kind: "blur", strength: "light" })}
        {tile("blur-strong", "Strong blur", <span className="vbg-blur strong" aria-hidden="true" />, { kind: "blur", strength: "strong" })}
        {BUILTIN_BACKGROUNDS.map(b => tile(`builtin-${b.id}`, b.label, <img className="vbg-image" src={svgDataUrl(b.svg)} alt="" />, { kind: "builtin", id: b.id }))}
        {items.map(item =>
          tile(
            `custom-${item.id}`,
            item.name,
            <img className="vbg-image" src={item.url} alt="" />,
            { kind: "custom", id: item.id },
            <button
              type="button"
              className="vbg-remove"
              aria-label={`Remove ${item.name}`}
              onClick={() => {
                if (value === `custom:${item.id}`) onChange("none");
                void remove(item.id);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>,
          ),
        )}
        <div className="vbg-cell">
          <Tooltip content="Upload an image" side="top">
            <button type="button" className="vbg-tile vbg-upload" aria-label="Upload background" disabled={!supported} onClick={() => file.current?.click()}>
              <Plus size={22} aria-hidden="true" />
            </button>
          </Tooltip>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            data-testid="background-upload"
            onChange={e => {
              const picked = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!picked) return;
              void add(picked).then(item => item && onChange(`custom:${item.id}`));
            }}
          />
        </div>
      </div>
      {!supported && <p className="vbg-note">{BACKGROUND_UNSUPPORTED_NOTE}</p>}
      {(error || libraryError) && (
        <p className="vbg-error" role="alert">
          {error || libraryError}
        </p>
      )}
    </div>
  );
}
