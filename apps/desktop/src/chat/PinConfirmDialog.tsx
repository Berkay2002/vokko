import { useEffect, type ReactNode } from 'react';
import { Modal, dmName, resolveUrl } from './shell';
import { File as FileIcon } from 'lucide-react';
import type { Channel, Message } from '../api/types';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { Markdown } from './markdown';
import { isImage } from './Attachments';
import { formatMessageTimestamp } from './util';

export type PinConfirmMode = 'pin' | 'unpin';

export interface PinConfirmCopy {
  title: string;
  body: string;
  cancel: string;
  confirm: string;
  danger: boolean;
}

/** Where a pin lands, as the app names it: "#general" in a server, the recipients' name in a DM. */
export function pinTargetLabel(channel: Pick<Channel, 'name' | 'guild_id' | 'recipients'> | undefined): string {
  if (!channel) return 'this conversation';
  if (channel.guild_id) return `#${channel.name ?? 'channel'}`;
  return dmName(channel as Channel);
}

/** The words of the pin / unpin confirmation (the footer buttons included). */
export function pinConfirmCopy(mode: PinConfirmMode, target: string): PinConfirmCopy {
  if (mode === 'unpin') {
    return { title: 'Unpin message?', body: 'Remove this message from the pinned list?', cancel: 'Cancel', confirm: 'Unpin', danger: true };
  }
  return {
    title: 'Pin this message?',
    body: `This will pin the message to ${target} so everyone can find it later.`,
    cancel: 'Cancel',
    confirm: 'Pin it',
    danger: false,
  };
}

/** Enter confirms from anywhere in the dialog except a focused control, which already reacts to Enter itself (Cancel must stay Cancel). */
export function enterConfirms(e: Pick<KeyboardEvent, 'key' | 'repeat' | 'defaultPrevented' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): boolean {
  if (e.key !== 'Enter' || e.repeat || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target as { closest?: (selector: string) => unknown } | null;
  return !(el && typeof el.closest === 'function' && el.closest('button, a, input, textarea, select, [contenteditable="true"]'));
}

/** The dialog shell: copy, preview slot, buttons, Enter / Escape. Escape and the backdrop close through the `Modal` layer. */
export function PinConfirmView({ open, mode, target, preview, onConfirm, onCancel }: { open: boolean; mode: PinConfirmMode; target: string; preview: ReactNode; onConfirm(): void; onCancel(): void }) {
  const copy = pinConfirmCopy(mode, target);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!enterConfirms(e)) return;
      e.preventDefault();
      onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onConfirm]);
  return <Modal open={open} onClose={onCancel} title={copy.title} className="chat-delete-modal chat-pin-modal"
    footer={<>
      <button type="button" className="chat-btn secondary" onClick={onCancel}>{copy.cancel}</button>
      <button type="button" className={`chat-btn ${copy.danger ? 'danger' : 'primary'}`} autoFocus onClick={onConfirm}>{copy.confirm}</button>
    </>}>
    <p className="chat-modal-text">{copy.body}</p>
    <div className="chat-pin-preview" aria-label="Message preview">{preview}</div>
  </Modal>;
}

/** Pin / unpin confirmation for a message of the open conversation, with the message drawn the way the list draws it. */
export function PinConfirmDialog({ message, onConfirm, onCancel }: { message: Message | null; onConfirm(): void; onCancel(): void }) {
  const chat = useChat();
  const m = message;
  const attachment = m?.attachments[0];
  return <PinConfirmView open={!!m} mode={m?.pinned ? 'unpin' : 'pin'} target={pinTargetLabel(chat.channel)} onConfirm={onConfirm} onCancel={onCancel}
    preview={m && <div className="chat-delete-preview">
      <Avatar user={m.author} size={40} guildId={chat.guildId} />
      <div className="chat-pin-preview-body">
        <div className="chat-msg-header"><span className="chat-author">{chat.nameOf(m.author, m.member)}</span> <span className="chat-timestamp">{formatMessageTimestamp(new Date(m.timestamp))}</span></div>
        {m.content && <Markdown content={m.content} ctx={chat.md} className="chat-content" />}
        {attachment && (isImage(attachment)
          ? <img className="chat-pin-preview-thumb" src={resolveUrl(attachment.url)} alt={attachment.description ?? attachment.filename} />
          : <div className="chat-pin-preview-file"><FileIcon size={18} aria-hidden="true" /><span>{attachment.filename}</span></div>)}
      </div>
    </div>} />;
}
