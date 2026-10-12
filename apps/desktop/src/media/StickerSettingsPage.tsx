// Server Settings > Stickers: upload, edit and delete. Server rules: PNG/APNG/GIF/WebP up to 512 KiB and 512x512, name 2-30, tags 2-200
// (comma separated), description up to 100, 60 per server, MANAGE_GUILD_EXPRESSIONS to change anything.
import { useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { ApiRequestError } from '../api/errors';
import { request, uploadAttachment } from '../api/rest';
import type { Channel, CreateStickerRequest, EditStickerRequest, Snowflake, Sticker } from '../api/types';
import { useLayer } from '../ui/layers';
import { useMedia } from './store';
import '../emoji/emoji.css';
import './sticker.css';

export const STICKER_MAX_BYTES = 512 * 1024;
export const STICKER_SLOTS = 60;
const TYPES = ['image/png', 'image/apng', 'image/gif', 'image/webp'];

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const fields = error.api?.errors as Record<string, { _errors?: { message?: string }[] }> | undefined;
    const first = fields && Object.values(fields)[0]?._errors?.[0]?.message;
    return first ?? error.message;
  }
  return 'Something went wrong. Try again.';
}

type Draft = { name: string; tags: string; description: string };

/** The server's rules on name and tags (characters, not UTF-16 units), checked before anything is uploaded. */
function draftError(draft: Draft): string | null {
  const name = [...draft.name.trim()].length;
  const tags = [...draft.tags.trim()].length;
  if (name < 2 || name > 30) return 'The name must be 2-30 characters.';
  if (tags < 2 || tags > 200) return 'Tags must be 2-200 characters.';
  if ([...draft.description.trim()].length > 100) return 'The description can be at most 100 characters.';
  return null;
}

function Fields({ draft, onChange, of }: { draft: Draft; onChange: (d: Draft) => void; of?: string }) {
  const label = (field: string) => (of ? `${field} of ${of}` : `Sticker ${field.toLowerCase()}`);

  return <>
    <input className="input" aria-label={label('Name')} placeholder="Name (2-30 characters)" value={draft.name} autoFocus={!!of} onChange={e => onChange({ ...draft, name: e.target.value })} />
    <input className="input" aria-label={label('Tags')} placeholder="Related emoji or tags, comma separated" value={draft.tags} onChange={e => onChange({ ...draft, tags: e.target.value })} />
    <input className="input" aria-label={label('Description')} placeholder="Description (optional)" value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} />
  </>;
}

function StickerRow({ guildId, sticker, canEdit }: { guildId: Snowflake; sticker: Sticker; canEdit: boolean }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); setError(null); done?.(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const save = () => {
    if (!draft) return;
    const invalid = draftError(draft);
    if (invalid) { setError(invalid); return; }
    const body: EditStickerRequest = { name: draft.name.trim(), tags: draft.tags.trim(), description: draft.description.trim() || null };
    void run(() => request<Sticker>('PATCH', `/guilds/${guildId}/stickers/${sticker.id}`, body), () => setDraft(null));
  };
  const cancel = () => { setDraft(null); setConfirming(false); setError(null); };
  // Escape cancels the edit or the delete confirm before it reaches the settings page
  useLayer(draft !== null || confirming, cancel);
  return <li data-sticker-id={sticker.id}>
    <img className="sticker-row-img" src={sticker.url} alt={sticker.name} />
    {draft
      ? <div className="sticker-form"><Fields draft={draft} onChange={setDraft} of={sticker.name} /></div>
      : <div><div>{sticker.name}</div><div className="sticker-row-tags">{sticker.tags}</div>{sticker.description && <div className="sticker-row-tags">{sticker.description}</div>}</div>}
    {canEdit && <div className="sticker-row-actions">
      {draft
        ? <><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
            <button type="button" className="btn btn-sm" onClick={cancel}>Cancel</button></>
        : confirming
          ? <><button type="button" className="btn btn-danger btn-sm" ref={el => el?.focus()} disabled={busy} aria-label={`Confirm delete ${sticker.name}`}
                onClick={() => void run(() => request('DELETE', `/guilds/${guildId}/stickers/${sticker.id}`))}>Delete?</button>
              <button type="button" className="btn btn-sm" onClick={cancel}>Cancel</button></>
          : <><button type="button" className="btn btn-sm" aria-label={`Edit ${sticker.name}`} onClick={() => setDraft({ name: sticker.name, tags: sticker.tags, description: sticker.description ?? '' })}>Edit</button>
              <button type="button" className="emoji-row-delete sticker-row-delete" aria-label={`Delete ${sticker.name}`} title="Delete" onClick={() => setConfirming(true)}><Trash2 size={16} /></button></>}
    </div>}
    {error && <p className="field-error sticker-row-error" role="alert">{error}</p>}
  </li>;
}

export function StickerSettingsPage({ guildId, canEdit, channels }: { guildId: Snowflake; canEdit: boolean; channels: Channel[] }) {
  const stickers = useMedia(s => s.stickers[guildId]) ?? [];
  const [draft, setDraft] = useState<Draft>({ name: '', tags: '', description: '' });
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const uploadChannel = channels.find(c => c.type === 0)?.id ?? channels[0]?.id;

  const pick = (f: File | undefined) => {
    setPicked(null);
    if (!f) return;
    // some webviews report no type for APNG/WebP: the server sniffs the file anyway
    const refused = f.type && !TYPES.includes(f.type) ? 'Stickers must be a PNG, APNG, GIF or WebP image.' : f.size > STICKER_MAX_BYTES ? 'Stickers must be 512 KiB or smaller.' : null;
    if (refused) {
      setError(refused);
      if (file.current) file.current.value = '';
      return;
    }
    setError(null);
    setPicked(f);
  };
  const upload = async () => {
    if (!picked) { setError('Choose an image first.'); return; }
    const invalid = draftError(draft);
    if (invalid) { setError(invalid); return; }
    if (!uploadChannel) { setError('This server has no channel to upload into.'); return; }
    setBusy(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(uploadChannel, picked);
      const body: CreateStickerRequest = { name: draft.name.trim(), tags: draft.tags.trim(), attachment_id: attachment.id };
      if (draft.description.trim()) body.description = draft.description.trim();
      await request<Sticker>('POST', `/guilds/${guildId}/stickers`, body);
      setDraft({ name: '', tags: '', description: '' });
      setPicked(null);
      if (file.current) file.current.value = '';
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-page emoji-settings">
    <h1>Stickers</h1>
    <section className="settings-category" aria-label="Upload Sticker">
      <h2 className="settings-category-title">Upload Sticker</h2>
      <ul className="emoji-reqs">
        <li>File type: PNG, APNG, GIF or WebP</li>
        <li>Max file size: 512 KiB, max 512x512 pixels</li>
        <li>Name 2-30 characters; tags 2-200 characters, comma separated</li>
      </ul>
      {canEdit
        ? <div className="sticker-form">
            <input ref={file} type="file" accept={TYPES.join(',')} aria-label="Sticker file" onChange={e => pick(e.target.files?.[0])} />
            <Fields draft={draft} onChange={setDraft} />
            <div><button type="button" className="btn btn-primary btn-sm emoji-upload-btn" disabled={busy || !uploadChannel} onClick={() => void upload()}>
              <Upload size={16} aria-hidden="true" /> {busy ? 'Uploading…' : 'Upload'}
            </button></div>
          </div>
        : <p className="emoji-list-empty">You need the Manage Expressions permission to add or change stickers.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
    <section className="emoji-list sticker-list" aria-label="Stickers">
      <h2 className="settings-category-title">Stickers — {stickers.length} of {STICKER_SLOTS}</h2>
      {stickers.length === 0 ? <p className="emoji-list-empty">None yet.</p>
        : <ul>{stickers.map(s => <StickerRow key={s.id} guildId={guildId} sticker={s} canEdit={canEdit} />)}</ul>}
    </section>
  </div>;
}
