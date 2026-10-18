import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { BottomSheet, usePhone } from "./BottomSheet";
import { useBackClose } from "./backHistory";
import { useFocusTrap, useLayer } from "./layers";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Rendered in the footer bar (buttons). */
  footer?: ReactNode;
  /** Extra class on the dialog (e.g. `modal-wide`). */
  className?: string;
  /** Hide the header close button. */
  hideClose?: boolean;
  /** Don't close when the backdrop is clicked. */
  persistent?: boolean;
  labelledBy?: string;
  /** At phone widths show as a BottomSheet (title row, content, footer) instead of a centered dialog. */
  sheet?: boolean;
  /** Focus the dialog itself on open instead of its first control or `data-autofocus` field. */
  focusSelf?: boolean;
}

/** Centered dialog with backdrop, Escape / backdrop close, focus trap and focus restore. */
export function Modal({ open, onClose, title, children, footer, className, hideClose, persistent, labelledBy, sheet, focusSelf }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const asSheet = !!sheet && phone;
  const layer = useLayer(open && !asSheet, onClose);
  useFocusTrap(open && !asSheet, () => dialog.current, true, focusSelf ? null : undefined);
  useBackClose(open && !asSheet && !persistent, onClose);
  if (!open) return null;
  if (asSheet) {
    return (
      <BottomSheet open onClose={onClose} label={typeof title === "string" ? title : "Dialog"} className={className} focusSelf={focusSelf}>
        {title !== undefined && <h2 className="sheet-title">{title}</h2>}
        {children}
        {footer && <div className="sheet-footer">{footer}</div>}
      </BottomSheet>
    );
  }
  return createPortal(
    <div className="modal-layer">
      {/* Only when this modal is the top layer: a click outside an open dropdown or popout closes just that. */}
      <div className="modal-backdrop" onMouseDown={persistent ? undefined : () => layer.isTop() && onClose()} />
      <div ref={dialog} className={`modal ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} aria-labelledby={labelledBy} tabIndex={-1}>
        {(title !== undefined || !hideClose) && (
          <div className="modal-header">
            <h2 className="modal-title">{title}</h2>
            {!hideClose && (
              <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
                <X size={22} />
              </button>
            )}
          </div>
        )}
        <div className="modal-content">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
