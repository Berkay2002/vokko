import { useRef } from "react";
import type { ComponentType, ReactNode, RefObject, UIEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useFocusTrap, useLayer } from "../../ui";

/**
 * The settings frame Discord uses for User Settings: a rounded modal inset from the window with the app dimmed behind it,
 * a sidebar on the left, a header bar with the current section title and one close button, and a centred scrolling column.
 * Styles in src/styles/settings-modal.css (classes `sm-*`).
 */
export interface SettingsModalProps {
  /** Accessible name of the dialog. */
  label: string;
  /** Title in the header bar (the current section). */
  title: string;
  /** Sidebar content: header, search, navigation. */
  side: ReactNode;
  onClose(): void;
  children: ReactNode;
  /** Receives the scrolling element, so the page can scroll to anchors. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScroll?(event: UIEvent<HTMLDivElement>): void;
  /** Changing this resets the scroll position to the top (a different page was opened). */
  pageKey: string;
}

export function SettingsModal({ label, title, side, onClose, children, scrollRef, onScroll, pageKey }: SettingsModalProps) {
  const root = useRef<HTMLDivElement>(null);
  useLayer(true, onClose);
  useFocusTrap(true, () => root.current);

  return createPortal(
    <div className="sm-layer">
      <div className="sm-backdrop" />
      <div ref={root} className="sm" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <nav className="sm-side" aria-label={`${label} sections`}>
          {side}
        </nav>
        <div className="sm-main">
          <header className="sm-header">
            <h1 className="sm-title">{title}</h1>
            <button type="button" className="sm-close" aria-label="Close" onClick={onClose}>
              <X size={22} />
            </button>
          </header>
          <div ref={scrollRef} key={pageKey} className="sm-scroll" onScroll={onScroll}>
            <div className="sm-column">{children}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Icon = ComponentType<{ size?: number | string; className?: string }>;

export function SettingsNavGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="sm-group">
      {title && <div className="sm-group-title">{title}</div>}
      {children}
    </div>
  );
}

export function SettingsNavItem({ icon: IconComponent, label, selected, danger, expanded, onClick }: {
  icon: Icon;
  label: string;
  selected?: boolean;
  danger?: boolean;
  /** Sub-items are shown below the active item; this marks the parent for assistive tech. */
  expanded?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`sm-item${selected ? " selected" : ""}${danger ? " danger" : ""}`}
      aria-current={selected ? "page" : undefined}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <IconComponent size={18} className="sm-item-icon" />
      <span className="sm-item-label">{label}</span>
    </button>
  );
}

/** Sub-items hang on a thin rail below their parent; the one in view carries a bar. */
export function SettingsNavSubs({ children }: { children: ReactNode }) {
  return <div className="sm-subs">{children}</div>;
}

export function SettingsNavSub({ label, active, onClick }: { label: string; active: boolean; onClick(): void }) {
  return (
    <button type="button" className={`sm-sub${active ? " active" : ""}`} aria-current={active ? "location" : undefined} onClick={onClick}>
      {label}
    </button>
  );
}

/** One settings row: label on the left, value and an action on the right. */
export function SettingsRow({ label, value, children }: { label: string; value?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sm-row">
      <div className="sm-row-label">{label}</div>
      {value !== undefined && <div className="sm-row-value">{value}</div>}
      {children}
    </div>
  );
}

/** A large-headed block of a single scrolling settings page; `anchor` is what the sidebar sub-items scroll to. */
export function SettingsBlock({ anchor, title, children }: { anchor: string; title: string; children: ReactNode }) {
  return (
    <section className="sm-block" data-anchor={anchor}>
      <h2 className="sm-block-title">{title}</h2>
      {children}
    </section>
  );
}
