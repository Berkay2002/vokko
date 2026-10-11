import type { ReactNode } from "react";
import { Pin } from "lucide-react";
import { Modal } from "./shell";

/**
 * Asks before a message is pinned and shows it. The caller passes the message preview as `children` (the chat renders its own
 * message markup, so nothing here ever interprets message content).
 */
export function PinConfirmModal({ open, channelName, children, onConfirm, onCancel }: { open: boolean; channelName: string | null; children: ReactNode; onConfirm(): void; onCancel(): void }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Pin this message?"
      className="cm-pin-modal"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" autoFocus onClick={onConfirm}>
            <Pin size={16} aria-hidden="true" />
            Pin message
          </button>
        </>
      }
    >
      <p className="modal-text cm-pin-text">
        It will join the pinned messages{channelName ? <> of <b>#{channelName}</b></> : null}, where everyone in the conversation can find it again.
      </p>
      <div className="cm-pin-preview" aria-label="Message to pin">
        {children}
      </div>
    </Modal>
  );
}
