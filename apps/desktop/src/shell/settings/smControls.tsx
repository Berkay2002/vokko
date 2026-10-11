import type { ComponentType, ReactNode } from "react";
import { ChevronRight, Info } from "lucide-react";

/** Small blocks of the User Settings pages that the shared controls do not cover. Styles: src/styles/settings-modal.css. */

type Icon = ComponentType<{ size?: number | string }>;

/** Bold 14 px lead-in above a group of switches or radios ("Show images, videos and lolcats ..."). */
export function SubHeading({ children, note, level = 3 }: { children: ReactNode; note?: ReactNode; level?: 2 | 3 }) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <>
      <Tag className="sm-sub-heading">{children}</Tag>
      {note && <p className="sm-sub-note">{note}</p>}
    </>
  );
}

/** "Related settings" row: icon tile, title, description and a chevron; the whole row is the button. */
export function RelatedSetting({ icon: IconComponent, label, note, onClick }: { icon: Icon; label: string; note: string; onClick(): void }) {
  return (
    <>
      <div className="sm-related-title">Related settings</div>
      <button type="button" className="sm-related" onClick={onClick}>
        <span className="sm-related-icon">
          <IconComponent size={20} />
        </span>
        <span className="sm-related-text">
          <span className="sm-related-label">{label}</span>
          <span className="sm-related-note">{note}</span>
        </span>
        <ChevronRight size={20} />
      </button>
    </>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="sm-banner" role="note">
      <Info size={20} />
      <span>{children}</span>
    </div>
  );
}
