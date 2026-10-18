import { useEffect, useMemo, useState } from 'react';
import { MailX, Play, Users, X } from 'lucide-react';
import type { Attachment, Embed, Message, Snowflake } from '../api/types';
import { AnimatedImage, AnimatedVideo, guildIconUrl, guildInitials, joinOrApply, request, resolveUrl, useGuilds } from './shell';
import { useChat } from './ChatContext';
import { Markdown } from './markdown';
import { embedColor, findInviteCodes, isVideoUrl, safeHttpUrl } from './embedUtil';
import { playerSrc } from './embedPlayers';
import { fileNameFromUrl } from './mediaTarget';
import { canSuppressEmbeds, embedsSuppressed } from './messageState';
import { removeEmbeds } from './mediaActions';
import { formatFullDate } from './util';
import { API_ORIGIN } from '../api/config';

/** Hosts whose `/invite/<code>` links are ours: the page's own and, in the desktop app, the API origin's. */
function inviteHosts(): string[] {
  const hosts = [window.location.host];
  try { if (API_ORIGIN) hosts.push(new URL(API_ORIGIN).host); } catch { /* bad VITE_VOKKO_API */ }
  return hosts;
}

// ---- invites (rendered client-side from GET /invites/{code}) ----

interface InviteInfo {
  code: string;
  guild: { id: Snowflake; name: string; icon: string | null; member_count?: number; join_mode?: number };
  member_count?: number;
}

const inviteCache = new Map<string, Promise<InviteInfo | null>>();
function loadInvite(code: string): Promise<InviteInfo | null> {
  let p = inviteCache.get(code);
  if (!p) {
    p = request<InviteInfo>('GET', `/invites/${encodeURIComponent(code)}`).catch(() => null);
    inviteCache.set(code, p);
  }
  return p;
}

function InviteEmbed({ code, own }: { code: string; own: boolean }) {
  const guilds = useGuilds();
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadInvite(code).then(i => { if (live) setInfo(i); });
    return () => { live = false; };
  }, [code]);

  if (info === undefined) {
    return <div className="chat-embed chat-invite loading" aria-busy="true"><div className="chat-invite-head">Loading invite…</div><div className="chat-invite-skeleton" /></div>;
  }
  if (info === null) {
    return <div className="chat-embed chat-invite invalid">
      <div className="chat-invite-head">{own ? 'You sent an invite, but' : 'You received an invite, but'}</div>
      <div className="chat-invite-row">
        <span className="chat-invite-icon bad"><MailX size={24} /></span>
        <div className="chat-invite-text">
          <div className="chat-invite-name bad">Invalid Invite</div>
          <div className="chat-invite-sub">{own ? 'Try sending a new invite!' : 'Try asking for a new invite!'}</div>
        </div>
      </div>
    </div>;
  }

  const joined = !!guilds[info.guild.id];
  const icon = guildIconUrl(info.guild);
  const memberCount = info.guild.member_count ?? info.member_count;
  async function join() {
    if (busy || joined) return;
    setBusy(true);
    setError(null);
    try { await joinOrApply(code); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not join this server.'); }
    setBusy(false);
  }
  return <div className="chat-embed chat-invite">
    <div className="chat-invite-head">{own ? 'You sent an invite to join a server' : 'You’ve been invited to join a server'}</div>
    <div className="chat-invite-row">
      <span className="chat-invite-icon">{icon ? <img src={resolveUrl(icon)} alt="" draggable={false} /> : <span>{guildInitials(info.guild.name)}</span>}</span>
      <div className="chat-invite-text">
        <div className="chat-invite-name">{info.guild.name}</div>
        {memberCount !== undefined && <div className="chat-invite-sub"><Users size={12} /> {memberCount} Member{memberCount === 1 ? '' : 's'}</div>}
        {error && <div className="chat-invite-error" role="alert">{error}</div>}
      </div>
      <button type="button" className="chat-invite-join" disabled={busy || joined} onClick={() => void join()}>{joined ? 'Joined' : info.guild.join_mode === 1 ? 'Apply' : 'Join'}</button>
    </div>
  </div>;
}

// ---- unfurled link embeds ----

function Media({ url, alt, className, onOpen }: { url: string | null; alt: string; className: string; onOpen?: () => void }) {
  if (!url) return null;
  const image = <AnimatedImage kind="gif" className={className} src={resolveUrl(url)} alt={alt} loading="lazy" draggable={false} />;
  return onOpen
    ? <button type="button" className={`chat-embed-media-btn${className === 'chat-embed-image' ? ' wide' : ''}`} aria-label={alt ? `Open image ${alt}` : 'Open image'} onClick={onOpen}>{image}</button>
    : image;
}

/** The picture as the viewer's only image: a stand-in attachment, since the viewer shows a message's attachments. */
function embedImageView(message: Message, src: string, embed: Embed, media?: { width?: number; height?: number }): Message {
  const attachment: Attachment = {
    id: `embed:${src}`, filename: fileNameFromUrl(src), content_type: 'image/*', size: 0, url: src,
    width: media?.width ?? null, height: media?.height ?? null, description: embed.title,
  };
  return { ...message, attachments: [attachment] };
}

/** A video page's poster. Allow-listed players swap it for their iframe on click (never before); anything else opens the link. */
function VideoPoster({ href, player, poster, title, open }: {
  href: string; player: string | null; poster: string | null; title?: string; open: (e: React.MouseEvent, href: string) => void;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (player && size) {
    return <iframe className="chat-embed-player" src={player} title={title ?? 'Embedded video'} style={size}
      sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />;
  }
  const click = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!player) { open(e, href); return; }
    e.preventDefault();
    // The poster's own box; without a poster image, a 16:9 box as wide as the embed.
    const box = (e.currentTarget.querySelector('.chat-embed-image') ?? e.currentTarget).getBoundingClientRect();
    setSize(box.height >= 90 ? { width: box.width, height: box.height } : { width: box.width, height: Math.round(box.width * 9 / 16) });
  };
  return <a className="chat-embed-poster" href={href} onClick={click} aria-label={player ? 'Play video' : 'Open video'}>
    {poster && <Media className="chat-embed-image" url={poster} alt="" />}
    <span className="chat-embed-play"><Play size={28} /></span>
  </a>;
}

function EmbedCard({ embed, message }: { embed: Embed; message: Message }) {
  const chat = useChat();
  const color = embedColor(embed.color);
  const link = safeHttpUrl(embed.url);
  const open = (e: React.MouseEvent, href: string) => { e.preventDefault(); chat.actions.openLink(href); };
  /** Enlarges a picture in the image viewer; where the surface has none, a click on the picture follows its link as before. */
  const view = (src: string, media: { width?: number; height?: number } | undefined, fallback?: string) => (): void => {
    if (!chat.actions.openImage(embedImageView(message, src, embed, media), 0) && fallback) chat.actions.openLink(fallback);
  };
  const mediaUrl = (m?: { url: string; proxy_url?: string }) => safeHttpUrl(m?.proxy_url ?? m?.url);
  const iconUrl = (m?: { icon_url?: string; proxy_icon_url?: string }) => safeHttpUrl(m?.proxy_icon_url ?? m?.icon_url);
  const authorIcon = iconUrl(embed.author);
  const footerIcon = iconUrl(embed.footer);

  // Settings > Chat > "Display images and videos from links": off keeps the text of the card only.
  const inlineMedia = chat.display.inlineEmbedMedia;
  if (!inlineMedia && (embed.type === 'image' || embed.type === 'gifv')) {
    const href = link ?? mediaUrl(embed.image) ?? mediaUrl(embed.thumbnail);
    return href ? <a className="chat-embed-media-link" href={href} onClick={e => open(e, href)}>{embed.title ?? href}</a> : null;
  }
  // A bare image link renders as just the image.
  if (embed.type === 'image') {
    const src = mediaUrl(embed.thumbnail) ?? mediaUrl(embed.image) ?? safeHttpUrl(embed.url);
    if (!src) return null;
    const show = view(src, embed.thumbnail ?? embed.image, link ?? src);
    return <a className="chat-embed-image-only" href={link ?? src} onClick={e => { e.preventDefault(); show(); }}><AnimatedImage kind="gif" src={resolveUrl(src)} alt={embed.title ?? 'Image'} loading="lazy" draggable={false} /></a>;
  }

  const videoUrl = safeHttpUrl(embed.video?.url);
  const inlineVideo = inlineMedia && !!videoUrl && (embed.type === 'gifv' || isVideoUrl(videoUrl));
  const image = inlineMedia ? mediaUrl(embed.image) : null;
  const thumb = inlineMedia ? mediaUrl(embed.thumbnail) : null;
  const authorUrl = safeHttpUrl(embed.author?.url);
  const hasText = !!(embed.title || embed.description || embed.fields?.length || embed.author || embed.provider?.name);
  const showVideoPoster = inlineMedia && !!videoUrl && !inlineVideo;

  return <article className="chat-embed chat-embed-rich" style={color ? { borderLeftColor: color } : undefined}>
    <div className="chat-embed-grid">
      <div className="chat-embed-main">
        {embed.provider?.name && <div className="chat-embed-provider">{embed.provider.name}</div>}
        {embed.author && <div className="chat-embed-author">
          {authorIcon && <Media className="chat-embed-author-icon" url={authorIcon} alt="" />}
          {authorUrl ? <a href={authorUrl} onClick={e => open(e, authorUrl)}>{embed.author.name}</a> : <span>{embed.author.name}</span>}
        </div>}
        {embed.title && (link
          ? <a className="chat-embed-title" href={link} onClick={e => open(e, link)}>{embed.title}</a>
          : <div className="chat-embed-title plain">{embed.title}</div>)}
        {embed.description && <Markdown content={embed.description} ctx={chat.md} className="chat-embed-desc" />}
        {embed.fields && embed.fields.length > 0 && <div className="chat-embed-fields">
          {embed.fields.map((f, i) => <div key={i} className={`chat-embed-field${f.inline ? ' inline' : ''}`}>
            <div className="chat-embed-field-name">{f.name}</div>
            <Markdown content={f.value} ctx={chat.md} className="chat-embed-field-value" />
          </div>)}
        </div>}
      </div>
      {thumb && !image && hasText && !showVideoPoster && <Media className="chat-embed-thumb" url={thumb} alt={embed.title ?? ''} onOpen={view(thumb, embed.thumbnail)} />}
    </div>
    {inlineVideo && (embed.type === 'gifv'
      ? <AnimatedVideo className="chat-embed-video" src={resolveUrl(videoUrl)} poster={image ?? thumb ?? undefined} loop muted playsInline />
      : <video className="chat-embed-video" src={resolveUrl(videoUrl)} poster={image ?? thumb ?? undefined} controls preload="metadata" playsInline />)}
    {showVideoPoster && <VideoPoster href={link ?? videoUrl} player={playerSrc(videoUrl, inlineMedia)} poster={image ?? thumb} title={embed.title} open={open} />}
    {!inlineVideo && !showVideoPoster && image && <Media className="chat-embed-image" url={image} alt={embed.title ?? ''} onOpen={view(image, embed.image)} />}
    {(embed.footer || embed.timestamp) && <div className="chat-embed-footer">
      {footerIcon && <Media className="chat-embed-footer-icon" url={footerIcon} alt="" />}
      <span>{embed.footer?.text}{embed.footer && embed.timestamp ? ' • ' : ''}{embed.timestamp ? formatFullDate(new Date(embed.timestamp)) : ''}</span>
    </div>}
  </article>;
}

export function Embeds({ message }: { message: Message }) {
  const chat = useChat();
  const { showEmbeds, hideInvites } = chat.display;
  // A message whose previews were removed (SUPPRESS_EMBEDS) shows no cards at all, invites included.
  const suppressed = embedsSuppressed(message);
  const embeds = showEmbeds && !suppressed ? message.embeds ?? [] : [];
  const found = useMemo(() => findInviteCodes(message.content, inviteHosts()), [message.content]);
  // "Show embeds" hides link previews only; invite cards stay unless streamer mode hides invites.
  const codes = hideInvites || suppressed ? [] : found;
  if (embeds.length === 0 && codes.length === 0) return null;
  const own = message.author.id === chat.me.id;
  const removable = embeds.length > 0 && canSuppressEmbeds(message, chat.me.id, chat.canManage);
  return <div className="chat-embeds">
    {codes.map(code => <InviteEmbed key={code} code={code} own={own} />)}
    {embeds.map((e, i) => {
      const card = <EmbedCard key={`${e.url ?? ''}:${i}`} embed={e} message={message} />;
      // The X removes every preview of the message (one flag), so it says so when there are several.
      return removable
        ? <div key={`${e.url ?? ''}:${i}`} className="chat-embed-slot">
          {card}
          <button type="button" className="chat-embed-remove" aria-label={embeds.length > 1 ? 'Remove all embeds' : 'Remove embed'} onClick={() => removeEmbeds(message)}><X size={16} /></button>
        </div>
        : card;
    })}
  </div>;
}
