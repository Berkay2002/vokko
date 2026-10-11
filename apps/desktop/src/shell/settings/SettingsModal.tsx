import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode, RefObject, UIEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";
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

/** Exit animation length (ms); keep in step with `.sm-layer.closing` in settings-modal.css. */
const EXIT_MS = 115;

function motionReduced(): boolean {
  return document.documentElement.classList.contains("reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SettingsModal({ label, title, side, onClose, children, scrollRef, onScroll, pageKey }: SettingsModalProps) {
  const root = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // Fullscreen phone layout (<= 485px, see styles/responsive.css): the section list and one page take turns.
  const [pane, setPane] = useState<"nav" | "page">(() => (window.matchMedia("(max-width: 485px)").matches ? "nav" : "page"));
  const timer = useRef<number | undefined>(undefined);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Esc, the x and a scrim click all play the exit first, then unmount through the real onClose.
  const requestClose = useCallback(() => {
    if (timer.current !== undefined) return;
    if (motionReduced()) {
      closeRef.current();
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(() => closeRef.current(), EXIT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayer(true, requestClose);
  useFocusTrap(true, () => root.current);

  return createPortal(
    <div className={`sm-layer${closing ? " closing" : ""}`}>
      <div className="sm-backdrop" onClick={requestClose} />
      <div ref={root} className="sm" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-pane={pane}>
        <nav className="sm-side" aria-label={`${label} sections`} onClick={e => (e.target as HTMLElement).closest(".sm-item, .sm-sub") && setPane("page")}>
          {side}
        </nav>
        <div className="sm-main">
          <div className="sm-header">
            <button type="button" className="sm-back" aria-label="Back to sections" onClick={() => setPane("nav")}>
              <ChevronLeft size={20} />
            </button>
            <h1 className="sm-title">{title}</h1>
            <button type="button" className="sm-close" aria-label="Close" onClick={requestClose}>
              <X size={20} />
            </button>
          </div>
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
      <IconComponent size={20} className="sm-item-icon" />
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
