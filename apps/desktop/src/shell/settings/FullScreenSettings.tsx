import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";
import { useFocusTrap, useInertApp, useLayer } from "../../ui";

/** Full-screen settings layer shared by server, channel and category settings (styles in src/styles/server-settings.css). */

/** "narrow" = 660 column, "wide" = ~1048 column (tables, preview card), "roles" = role list column + editor. */
export type FrameLayout = "narrow" | "wide" | "roles";

const FrameLayoutContext = createContext<(layout: FrameLayout) => void>(() => undefined);

/** A page calls this to ask the frame for a wider content column while it is mounted. */
export function useFrameLayout(layout: FrameLayout): void {
  const set = useContext(FrameLayoutContext);
  useEffect(() => {
    set(layout);
    return () => set("narrow");
  }, [layout, set]);
}

export interface SettingsNavItem {
  id: string;
  label: string;
  /** Red item (delete). Calls onSelect instead of switching pages. */
  danger?: boolean;
  icon?: ReactNode;
  onSelect?(): void;
}

export interface SettingsNavGroup {
  id: string;
  /** Eyebrow heading; groups are separated by a 1px rule. */
  title?: string;
  items: SettingsNavItem[];
}

export function FullScreenSettings({
  label,
  navLabel,
  eyebrow,
  eyebrowTitle,
  groups,
  current,
  onSelect,
  onClose,
  children,
}: {
  label: string;
  navLabel: string;
  eyebrow: ReactNode;
  eyebrowTitle?: string;
  groups: SettingsNavGroup[];
  current: string;
  onSelect(id: string): void;
  onClose(): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<FrameLayout>("narrow");
  // Phone layout (<= 485px, styles/responsive.css): the section list and one page take turns, like User Settings.
  const [pane, setPane] = useState<"nav" | "page">(() => (window.matchMedia("(max-width: 485px)").matches ? "nav" : "page"));
  useLayer(true, onClose);
  useInertApp(true);
  useFocusTrap(true, () => root.current);

  return createPortal(
    <div ref={root} className={`fss fss-${layout}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-pane={pane}>
      <nav className="fss-sidebar" aria-label={navLabel} onClick={e => (e.target as HTMLElement).closest(".fss-item:not(.danger)") && setPane("page")}>
        <button type="button" className="fss-nav-close" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
        <div className="fss-sidebar-column">
          <div className="fss-eyebrow fss-eyebrow-top" title={eyebrowTitle}>
            {eyebrow}
          </div>
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && <div className="fss-separator" role="separator" />}
              {group.title && <div className="fss-eyebrow">{group.title}</div>}
              {group.items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`fss-item${current === item.id && !item.danger ? " selected" : ""}${item.danger ? " danger" : ""}`}
                  aria-current={current === item.id && !item.danger ? "page" : undefined}
                  onClick={() => (item.danger ? item.onSelect?.() : onSelect(item.id))}
                >
                  <span className="fss-item-label">{item.label}</span>
                  {item.icon}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      </nav>
      <main className="fss-content">
        <button type="button" className="fss-back" aria-label="Back to sections" onClick={() => setPane("nav")}>
          <ChevronLeft size={20} />
        </button>
        <div className="fss-row">
          <FrameLayoutContext.Provider value={setLayout}>
            <div className="fss-column">{children}</div>
          </FrameLayoutContext.Provider>
          <div className="fss-tools">
            <button type="button" className="fss-close" aria-label="Close" onClick={onClose}>
              <span className="fss-close-icon">
                <X size={18} />
              </span>
              <span className="fss-close-label">ESC</span>
            </button>
          </div>
        </div>
      </main>
    </div>,
    document.body,
  );
}
