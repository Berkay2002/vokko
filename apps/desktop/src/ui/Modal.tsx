import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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
}

/** Centered dialog with backdrop, Escape / backdrop close, focus trap and focus restore. */
export function Modal({ open, onClose, title, children, footer, className, hideClose, persistent, labelledBy }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const layer = useLayer(open, onClose);
  useFocusTrap(open, () => dialog.current);
  if (!open) return null;
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
