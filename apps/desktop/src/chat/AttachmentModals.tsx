import { useState } from 'react';
import { FileIcon } from 'lucide-react';
import { Modal } from './shell';
import { SPOILER_PREFIX, isSpoilerName, stripSpoiler, withSpoiler } from './util';

export const MAX_ALT_LENGTH = 1024;

export interface AttachmentDetails {
  /** Name as it will be sent, including a "SPOILER_" prefix when marked. */
  filename: string;
  description: string;
}

interface ModifyProps {
  /** The attachment being modified; null closes the dialog. */
  target: { details: AttachmentDetails; thumbUrl: string | null } | null;
  /** Sent attachments can't be changed by the server contract: the fields are shown but locked. */
  readOnly?: boolean;
  onSave(next: AttachmentDetails): void;
  onClose(): void;
}

/** "Modify Attachment": thumbnail, file name, alt text and spoiler mark; Cancel (grey) and Save (blurple) as two equal buttons. */
export function ModifyAttachmentModal({ target, readOnly, onSave, onClose }: ModifyProps) {
  return <Modal open={!!target} onClose={onClose} title="Modify Attachment" className="chat-attachment-modal"
    footer={<div className="chat-modal-split">
      <button type="button" className="chat-btn secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form="chat-attachment-form" className="chat-btn primary" disabled={readOnly}>Save</button>
    </div>}>
    {target && <ModifyBody key={target.details.filename} details={target.details} thumbUrl={target.thumbUrl} readOnly={!!readOnly} onSave={onSave} onClose={onClose} />}
  </Modal>;
}

function ModifyBody({ details, thumbUrl, readOnly, onSave, onClose }: { details: AttachmentDetails; thumbUrl: string | null; readOnly: boolean; onSave(next: AttachmentDetails): void; onClose(): void }) {
  const [name, setName] = useState(stripSpoiler(details.filename));
  const [alt, setAlt] = useState(details.description);
  const [spoiler, setSpoiler] = useState(isSpoilerName(details.filename));
  const valid = name.trim().length > 0 && name.trim().length <= 255 - SPOILER_PREFIX.length;
  return <form id="chat-attachment-form" className="chat-attachment-form" onSubmit={e => {
    e.preventDefault();
    if (readOnly || !valid) return;
    onSave({ filename: withSpoiler(name.trim(), spoiler), description: alt.trim() });
    onClose();
  }}>
    <div className="chat-attachment-thumb">{thumbUrl ? <img src={thumbUrl} alt="" draggable={false} /> : <FileIcon size={48} aria-hidden="true" />}</div>
    <label className="chat-field"><span>Filename</span>
      <input type="text" value={name} maxLength={255 - SPOILER_PREFIX.length} readOnly={readOnly} autoFocus onChange={e => setName(e.target.value)} />
    </label>
    <label className="chat-field"><span>Description (alt text)</span>
      <textarea value={alt} maxLength={MAX_ALT_LENGTH} readOnly={readOnly} rows={3} placeholder="Describe the image for people who can't see it" onChange={e => setAlt(e.target.value)} />
    </label>
    <label className="chat-check">
      <input type="checkbox" checked={spoiler} disabled={readOnly} onChange={e => setSpoiler(e.target.checked)} />
      <span>Mark as spoiler</span>
    </label>
    {readOnly && <p className="chat-field-note">The name, description and spoiler mark of a sent attachment can't be changed.</p>}
  </form>;
}

/** "Are you sure?" before an attachment is removed from a sent message. Clicking the backdrop closes it. */
export function DeleteAttachmentModal({ open, busy, onConfirm, onClose }: { open: boolean; busy?: boolean; onConfirm(): void; onClose(): void }) {
  return <Modal open={open} onClose={onClose} title="Are you sure?" className="chat-attachment-modal"
    footer={<div className="chat-modal-split">
      <button type="button" className="chat-btn secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="chat-btn danger" disabled={busy} onClick={onConfirm}>Delete Attachment</button>
    </div>}>
    <p className="chat-modal-text">This will permanently delete the attachment from the message.</p>
  </Modal>;
}
