// Server Settings > Emoji: upload, rename, delete and the list (static and animated, each with its uploader). Server rules: PNG/GIF/WebP
// up to 256 KiB, names 2-32 of [A-Za-z0-9_], 250 static + 250 animated per server, MANAGE_GUILD_EXPRESSIONS to change anything.
import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { ApiRequestError } from '../api/errors';
import { request, uploadAttachment } from '../api/rest';
import { avatarUrl, displayName } from '../api/store';
import type { Channel, CreateGuildEmojiRequest, GuildEmoji, Snowflake } from '../api/types';
import { emojiStore } from './store';
import './emoji.css';

export const EMOJI_MAX_BYTES = 256 * 1024;
export const EMOJI_SLOTS = 250;
const NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
const TYPES = ['image/png', 'image/gif', 'image/webp'];

/** Emoji name from a file name: invalid characters become `_`, padded/cut to 2-32 (Discord does the same). */
export function nameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const cut = base.slice(0, 32);
  return cut.length >= 2 ? cut : `${cut}emoji`.slice(0, 32);
}

/** Client-side check before uploading (the server re-checks): returns an error text or null. */
export function checkEmojiFile(file: { type: string; size: number }): string | null {
  if (!TYPES.includes(file.type)) return 'Emoji must be a PNG, GIF or WebP image.';
  if (file.size > EMOJI_MAX_BYTES) return 'Emoji must be 256 KiB or smaller.';
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const fields = error.api?.errors as Record<string, { _errors?: { message?: string }[] }> | undefined;
    const first = fields && Object.values(fields)[0]?._errors?.[0]?.message;
    return first ?? error.message;
  }
  return 'Something went wrong. Try again.';
}

function EmojiRow({ guildId, emoji, canEdit, onError }: { guildId: Snowflake; emoji: GuildEmoji; canEdit: boolean; onError: (text: string | null) => void }) {
  const [name, setName] = useState(emoji.name);
  useEffect(() => setName(emoji.name), [emoji.name]);
  const save = async () => {
    if (name === emoji.name) return;
    if (!NAME_RE.test(name)) {
      onError('Emoji names must be 2-32 characters of letters, numbers and underscores.');
      setName(emoji.name);
      return;
    }
    try {
      await request<GuildEmoji>('PATCH', `/guilds/${guildId}/emojis/${emoji.id}`, { name });
      onError(null);
    } catch (e) {
      onError(errorText(e));
      setName(emoji.name);
    }
  };
  const remove = async () => {
    try {
      await request('DELETE', `/guilds/${guildId}/emojis/${emoji.id}`);
      onError(null);
    } catch (e) {
      onError(errorText(e));
    }
  };
  return <li className="emoji-row" data-emoji-id={emoji.id}>
    <img className="emoji-row-img" src={emoji.url} alt={`:${emoji.name}:`} />
    <div className="emoji-row-name">
      {canEdit
        ? <input className="input emoji-name-input" aria-label={`Rename ${emoji.name}`} value={name} maxLength={32} onChange={e => setName(e.target.value)}
            onBlur={() => void save()} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(emoji.name); e.currentTarget.blur(); } }} />
        : <span>:{emoji.name}:</span>}
    </div>
    <div className="emoji-row-uploader">
      {emoji.user && <><img className="emoji-row-avatar" src={avatarUrl(emoji.user)} alt="" /><span>{displayName(emoji.user)}</span></>}
    </div>
    {canEdit && <button type="button" className="emoji-row-delete" aria-label={`Delete ${emoji.name}`} title="Delete" onClick={() => void remove()}><Trash2 size={16} /></button>}
  </li>;
}

function EmojiList({ title, guildId, emojis, canEdit, onError }: { title: string; guildId: Snowflake; emojis: GuildEmoji[]; canEdit: boolean; onError: (text: string | null) => void }) {
  return <section className="emoji-list" aria-label={title}>
    <h2 className="settings-category-title">{title} — {EMOJI_SLOTS - emojis.length} of {EMOJI_SLOTS} slots available</h2>
    {emojis.length === 0 ? <p className="emoji-list-empty">None yet.</p> : <>
      <div className="emoji-list-head" aria-hidden="true"><span>Image</span><span>Name</span><span>Uploaded by</span></div>
      <ul>{emojis.map(e => <EmojiRow key={e.id} guildId={guildId} emoji={e} canEdit={canEdit} onError={onError} />)}</ul>
    </>}
  </section>;
}

export function EmojiSettingsPage({ guildId, canEdit, channels }: { guildId: Snowflake; canEdit: boolean; channels: Channel[] }) {
  const live = emojiStore(s => s.byGuild[guildId]);
  const [list, setList] = useState<GuildEmoji[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const uploadChannel = channels.find(c => c.type === 0)?.id ?? channels[0]?.id;

  // The list with uploaders comes from REST; every GUILD_EMOJIS_UPDATE (live list change) refetches it.
  useEffect(() => {
    let alive = true;
    request<GuildEmoji[]>('GET', `/guilds/${guildId}/emojis`)
      .then(next => { if (alive) setList(next); })
      .catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [guildId, live]);

  const upload = async (selected: File | undefined) => {
    if (!selected) return;
    const problem = checkEmojiFile(selected);
    if (problem) { setError(problem); return; }
    if (!uploadChannel) { setError('This server has no channel to upload into.'); return; }
    setBusy(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(uploadChannel, selected);
      const body: CreateGuildEmojiRequest = { name: nameFromFile(selected.name), image_attachment_id: attachment.id };
      await request<GuildEmoji>('POST', `/guilds/${guildId}/emojis`, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  const all = list ?? [];
  const statics = all.filter(e => !e.animated);
  const animated = all.filter(e => e.animated);
  return <div className="settings-page emoji-settings">
    <h1>Emoji</h1>
    <p className="emoji-settings-lead">
      Add up to {EMOJI_SLOTS} custom emoji and {EMOJI_SLOTS} animated emoji that anyone in this server can use. Members can use them in every server and DM, free.
    </p>
    <section className="settings-category">
      <h2 className="settings-category-title">Upload Requirements</h2>
      <ul className="emoji-reqs">
        <li>File type: PNG, GIF or WebP</li>
        <li>Max file size: 256 KiB</li>
        <li>Recommended size: 128x128</li>
        <li>Naming: at least 2 characters, letters, numbers and underscores only</li>
      </ul>
      {canEdit
        ? <button type="button" className="btn btn-primary btn-sm emoji-upload-btn" disabled={busy || !uploadChannel} onClick={() => file.current?.click()}>
            <Upload size={16} aria-hidden="true" /> {busy ? 'Uploading…' : 'Upload Emoji'}
          </button>
        : <p className="emoji-list-empty">You need the Manage Expressions permission to add or change emoji.</p>}
      <input ref={file} type="file" accept={TYPES.join(',')} hidden aria-label="Emoji file" onChange={e => void upload(e.target.files?.[0])} />
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
    {list === null && !error ? <p className="emoji-list-empty">Loading…</p> : <>
      <EmojiList title="Emoji" guildId={guildId} emojis={statics} canEdit={canEdit} onError={setError} />
      <EmojiList title="Animated Emoji" guildId={guildId} emojis={animated} canEdit={canEdit} onError={setError} />
    </>}
  </div>;
}
