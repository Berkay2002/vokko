import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Download, ExternalLink, File as FileIcon, Forward, Link2, MoreHorizontal, Pencil, Trash2, ZoomIn, FileArchive, FileAudio, FileCode, FileText, FileVideo, ImageOff, X } from 'lucide-react';
import type { Attachment, Message } from '../api/types';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { ServerTag } from './ServerTag';
import { AnimatedImage, Tooltip, resolveUrl, useShowImageDescriptions } from './shell';
import { openForward } from '../media/store';
import { formatBytes, formatFullDate, formatMessageTimestamp, stripSpoiler } from './util';
import { VoicePlayer, isVoiceMessage } from './VoiceMessage';
import { TextPreview } from './TextPreview';
import { isTextPreviewable } from './textAttachment';
import { saveOnClick } from './mediaActions';
import { revealSpoiler, useIsCovered } from './spoilers';
import { RESET, type View } from './lightboxZoom';
import { useViewerGestures } from './useViewerGestures';

/** A link preview's picture shown in the viewer as a stand-in attachment (Embeds.tsx): it has no message file to forward. */
export const isEmbedImage = (a: Attachment): boolean => a.id.startsWith('embed:');

export const isImage = (a: Attachment): boolean => !!a.content_type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(a.filename);
const isVideo = (a: Attachment): boolean => !!a.content_type?.startsWith('video/');
const isAudio = (a: Attachment): boolean => !!a.content_type?.startsWith('audio/') || /\.(mp3|ogg|oga|wav|flac|m4a|opus)$/i.test(a.filename);
/** Formats that can animate: they follow Settings > Accessibility > "Play GIFs when Vokko is focused". */
const isAnimatable = (a: Attachment): boolean => /^image\/(gif|apng|webp)$/.test(a.content_type ?? '') || /\.(gif|apng|webp)$/i.test(a.filename);

// Discord's message media box: 550 x 400 CSS px, aspect-fit, never upscaled (measured: a 2.16:1 screenshot renders 550 x 254).
const MAX_SINGLE_W = 550;
const MAX_SINGLE_H = 350;

function fileIcon(a: Attachment) {
  const t = a.content_type ?? '';
  if (t.startsWith('audio/')) return FileAudio;
  if (t.startsWith('video/')) return FileVideo;
  if (/zip|tar|gzip|7z|rar/.test(t) || /\.(zip|tar|gz|7z|rar)$/i.test(a.filename)) return FileArchive;
  if (t.startsWith('text/') || /\.(txt|md|log|pdf)$/i.test(a.filename)) return FileText;
  if (/\.(js|ts|tsx|jsx|rs|py|json|html|css|go|java|c|cpp|cs|sh|ya?ml|toml)$/i.test(a.filename)) return FileCode;
  return FileIcon;
}

function ImageTile({ message, attachment, index, style, className }: { message: Message; attachment: Attachment; index: number; style?: React.CSSProperties; className?: string }) {
  const chat = useChat();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const spoiler = useIsCovered()(attachment);
  const own = message.author.id === chat.me.id && !message.id.startsWith('pending:');
  const url = resolveUrl(attachment.url);
  return <div className={`chat-image-wrap${className ? ` ${className}` : ''}`} style={style}>
    <button type="button" className={`chat-image${spoiler ? ' spoiler' : ''}${loaded ? ' loaded' : ''}${failed ? ' failed' : ''}`} aria-label={`Open image ${(!spoiler && attachment.description) || attachment.filename}`} data-src={url}
      onClick={() => (spoiler ? revealSpoiler(attachment.id) : chat.actions.openImage(message, index))}>
      {isAnimatable(attachment)
        ? <AnimatedImage kind="gif" src={url} alt={attachment.description || attachment.filename} loading="lazy" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        : <img src={url} alt={attachment.description || attachment.filename} loading="lazy" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
      {spoiler && <span className="chat-image-spoiler-label">SPOILER</span>}
      {failed && <span className="chat-image-failed"><ImageOff size={24} /></span>}
    </button>
    {!spoiler && own && <div className="chat-image-actions own">
      <Tooltip content="Modify Attachment" side="top"><button type="button" className="chat-image-action" aria-label="Modify Attachment" onClick={() => chat.actions.viewAttachment(message, attachment)}><Pencil size={16} /></button></Tooltip>
      <Tooltip content="Remove Attachment From Message" side="top"><button type="button" className="chat-image-action danger" aria-label="Remove Attachment From Message" onClick={() => chat.actions.deleteAttachment(message, attachment)}><Trash2 size={16} /></button></Tooltip>
    </div>}
    {!spoiler && !own && <div className="chat-image-actions">
      <Tooltip content="Open in Browser" side="top"><a className="chat-image-action" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in Browser"><ExternalLink size={16} /></a></Tooltip>
      <Tooltip content="Download" side="top"><a className="chat-image-action" href={url} download={attachment.filename} aria-label="Download" onClick={saveOnClick(url, attachment.filename)}><Download size={16} /></a></Tooltip>
    </div>}
  </div>;
}

/** Discord-style layouts: 1 single, 2 side by side, 3 one tall + two stacked, 4 grid, 5 two over three, 6+ rows of three. */
function ImageGrid({ message, images }: { message: Message; images: { a: Attachment; index: number }[] }) {
  if (images.length === 1) {
    const { a, index } = images[0]!;
    const w = a.width ?? MAX_SINGLE_W, h = a.height ?? MAX_SINGLE_H;
    const scale = Math.min(1, MAX_SINGLE_W / w, MAX_SINGLE_H / h);
    const width = Math.max(40, Math.round(w * scale)), height = Math.max(40, Math.round(h * scale));
    return <div className="chat-image-grid single"><ImageTile message={message} attachment={a} index={index} style={{ width, height, aspectRatio: `${width} / ${height}` }} /></div>;
  }
  const n = Math.min(images.length, 10);
  const shown = images.slice(0, n);
  if (n === 3) {
    // Measured: 550x350 box, one 364x350 tile on the left and two 182x173 tiles stacked on the right, 4px gaps.
    const [first, second, third] = shown as [typeof shown[number], typeof shown[number], typeof shown[number]];
    return <div className="chat-image-grid multi three" data-count={3}>
      <ImageTile message={message} attachment={first.a} index={first.index} className="fill" />
      <div className="chat-image-col">
        <ImageTile message={message} attachment={second.a} index={second.index} className="fill" />
        <ImageTile message={message} attachment={third.a} index={third.index} className="fill" />
      </div>
    </div>;
  }
  const rows: number[] = n === 2 ? [2] : n === 3 ? [1, 2] : n === 4 ? [2, 2] : n === 5 ? [2, 3] : n === 6 ? [3, 3] : n === 7 ? [1, 3, 3] : n === 8 ? [2, 3, 3] : n === 9 ? [3, 3, 3] : [1, 3, 3, 3];
  let cursor = 0;
  return <div className="chat-image-grid multi" data-count={n}>
    {rows.map((count, ri) => {
      const slice = shown.slice(cursor, cursor + count);
      cursor += count;
      // Measured: two images are two 273x273 cells (550 wide, 4px gap), four are a 2x2 of 273x173 cells (550x350). Other layouts: rows of 160px.
      return <div className="chat-image-row" key={ri} style={{ height: n === 2 ? 273 : n === 4 ? 173 : 160 }}>
        {slice.map(({ a, index }) => <ImageTile key={a.id} message={message} attachment={a} index={index} className="fill" />)}
      </div>;
    })}
  </div>;
}

/**
 * Card under a message that is still being sent: file icon, "Uploading 2 files", progress bar, and a cancel X (measured 432x74, radius 8,
 * 8px bar). The bar is indeterminate because the files were already uploaded from the tray; what is in flight is the message itself.
 */
export function PendingUpload({ files, onCancel }: { files: Attachment[]; onCancel(): void }) {
  const title = files.length === 1 ? `Uploading ${files[0]!.filename}` : `Uploading ${files.length} files`;
  return <div className="chat-pending-upload" role="status">
    <FileIcon size={40} className="chat-pending-upload-icon" aria-hidden="true" />
    <div className="chat-pending-upload-main">
      <div className="chat-pending-upload-title">{title}</div>
      <div className="chat-pending-upload-bar" aria-hidden="true"><div /></div>
    </div>
    <Tooltip content="Cancel Upload" side="top"><button type="button" className="chat-pending-upload-cancel" aria-label="Cancel Upload" onClick={onCancel}><X size={20} /></button></Tooltip>
  </div>;
}

export function Attachments({ message }: { message: Message }) {
  const chat = useChat();
  const showDescriptions = useShowImageDescriptions();
  const covered = useIsCovered();
  if (message.attachments.length === 0) return null;
  if (isVoiceMessage(message) && message.attachments[0]) return <div className="chat-attachments"><VoicePlayer attachment={message.attachments[0]} /></div>;
  // Settings > Chat > "Display images, videos and lolcats": off shows every upload as a file card.
  const inline = chat.display.inlineAttachmentMedia;
  const images: { a: Attachment; index: number }[] = [];
  const others: Attachment[] = [];
  message.attachments.forEach((a, index) => { if (inline && isImage(a)) images.push({ a, index }); else others.push(a); });
  return <div className="chat-attachments">
    {images.length > 0 && <ImageGrid message={message} images={images} />}
    {others.map(a => inline && isVideo(a)
      ? <VideoAttachment key={a.id} attachment={a} />
      : <FileCard key={a.id} attachment={a} />)}
    {showDescriptions && message.attachments.filter(a => a.description && !covered(a)).map(a => <p key={a.id} className="chat-attachment-alt"><span className="chat-attachment-alt-tag">ALT</span>{a.description}</p>)}
  </div>;
}

/** A video upload. Behind a SPOILER_ name the frame is blurred, has no controls and nothing plays until the cover is clicked. */
function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const covered = useIsCovered()(attachment);
  const url = resolveUrl(attachment.url);
  if (!covered) return <video className="chat-video" src={url} controls preload="metadata" />;
  return <div className="chat-video-wrap">
    <video className="chat-video spoiler" src={url} preload="metadata" aria-hidden="true" tabIndex={-1} />
    <button type="button" className="chat-spoiler-cover" aria-label="Reveal spoiler video" onClick={() => revealSpoiler(attachment.id)}><span className="chat-image-spoiler-label">SPOILER</span></button>
  </div>;
}

export function FileCard({ attachment, plain }: { attachment: Attachment; plain?: boolean }) {
  const covered = useIsCovered()(attachment);
  if (!plain && isTextPreviewable(attachment)) return <TextPreview attachment={attachment}><FileCard attachment={attachment} plain /></TextPreview>;
  const Icon = fileIcon(attachment);
  const audio = isAudio(attachment);
  const shown = stripSpoiler(attachment.filename);
  // Covered: no name, size, link or player in the page at all until the click.
  if (covered) {
    return <button type="button" className="chat-file spoiler" aria-label="Reveal spoiler file" onClick={() => revealSpoiler(attachment.id)}>
      <Icon className="chat-file-icon" size={40} aria-hidden="true" />
      <span className="chat-file-spoiler">SPOILER</span>
    </button>;
  }
  return <div className={`chat-file${audio ? ' audio' : ''}`}>
    <Icon className="chat-file-icon" size={40} aria-hidden="true" />
    <div className="chat-file-meta">
      <a className="chat-file-name" href={resolveUrl(attachment.url)} target="_blank" rel="noopener noreferrer" title={shown}>{shown}</a>
      <span className="chat-file-size">{formatBytes(attachment.size)}</span>
    </div>
    <a className="chat-file-download" href={resolveUrl(attachment.url)} download={attachment.filename} aria-label={`Download ${shown}`} title="Download" onClick={saveOnClick(resolveUrl(attachment.url), attachment.filename)}><Download size={24} /></a>
    {audio && <audio className="chat-audio" src={resolveUrl(attachment.url)} controls preload="metadata" aria-label={shown} />}
  </div>;
}

export function Lightbox({ message, index, onClose }: { message: Message; index: number; onClose: () => void }) {
  const chat = useChat();
  const images = message.attachments.filter(isImage);
  const start = Math.max(0, images.findIndex(a => a.id === message.attachments[index]?.id));
  const [i, setI] = useState(start);
  const [view, setView] = useState<View>(RESET);
  const [more, setMore] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const cur = images[i];
  const covered = useIsCovered();
  const go = (n: number) => { setI(Math.max(0, Math.min(images.length - 1, n))); setView(RESET); };
  const zoomed = view.scale > 1;
  const gestures = useViewerGestures({ stage, image: img, view, setView, canSwipe: images.length > 1, step: d => go(i + d) });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (more) setMore(false); else onClose(); }
      else if (e.key === 'ArrowLeft') { setI(v => Math.max(0, v - 1)); setView(RESET); }
      else if (e.key === 'ArrowRight') { setI(v => Math.min(images.length - 1, v + 1)); setView(RESET); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [images.length, onClose, more]);
  if (!cur) return null;
  const hidden = covered(cur); // an unrevealed SPOILER_ picture: blurred, no zoom, no link to the original, no description
  const author = chat.userById(message.author.id) ?? message.author;
  const color = chat.colorOf(message);
  const url = resolveUrl(cur.url);
  const date = new Date(message.timestamp);
  return createPortal(<div className="chat-lightbox" role="dialog" aria-modal="true" aria-label={(!hidden && cur.description) || cur.filename} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="chat-lightbox-modal" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <header className="chat-lightbox-top">
        <Avatar user={message.author} size={40} guildId={chat.guildId} />
        <div className="chat-lightbox-who">
          <div className="chat-lightbox-name"><span style={color ? { color } : undefined}>{chat.nameOf(message.author, message.member)}</span><ServerTag user={author} /></div>
          <Tooltip content={formatFullDate(date)} side="bottom"><time className="chat-lightbox-time" dateTime={message.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>
        </div>
        <div className="chat-lightbox-actions" role="toolbar" aria-label="Image actions">
          {!hidden && <Tooltip content={zoomed ? 'Zoom out' : 'Zoom in'} side="bottom"><button type="button" className="chat-lightbox-btn" aria-label={zoomed ? 'Zoom out' : 'Zoom in'} aria-pressed={zoomed} onClick={() => setView(v => (v.scale > 1 ? RESET : { ...v, scale: 2 }))}><ZoomIn size={20} /></button></Tooltip>}
          {!isEmbedImage(cur) && <Tooltip content="Forward" side="bottom"><button type="button" className="chat-lightbox-btn" aria-label="Forward" onClick={() => openForward(message)}><Forward size={20} /></button></Tooltip>}
          {!hidden && <Tooltip content="Open in Browser" side="bottom"><a className="chat-lightbox-btn" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in Browser"><ExternalLink size={20} /></a></Tooltip>}
          {!hidden && <div className="chat-lightbox-more">
            <Tooltip content="More" side="bottom"><button type="button" className="chat-lightbox-btn" aria-label="More" aria-expanded={more} onClick={() => setMore(m => !m)}><MoreHorizontal size={20} /></button></Tooltip>
            {more && <div className="chat-lightbox-menu" role="menu">
              <a role="menuitem" href={url} download={cur.filename} onClick={e => { saveOnClick(url, cur.filename)(e); setMore(false); }}><Download size={16} /> Download</a>
              <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(url); setMore(false); }}><Link2 size={16} /> Copy Link</button>
            </div>}
          </div>}
        </div>
        <button type="button" className="chat-lightbox-close" aria-label="Close" onClick={onClose}><X size={20} /></button>
      </header>
      <div ref={stage} className={`chat-lightbox-stage${images.length > 1 ? ' with-thumbs' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        {i > 0 && <button type="button" className="chat-lightbox-nav prev" aria-label="Previous" onClick={() => go(i - 1)}><ArrowLeft size={20} /></button>}
        <img ref={img} className={`${zoomed ? 'zoomed' : ''}${gestures.dragging ? ' dragging' : ''}${hidden ? ' spoiler' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} src={url} alt={(!hidden && cur.description) || cur.filename} draggable={false} onClick={e => (hidden ? revealSpoiler(cur.id) : gestures.toggle(e.clientX, e.clientY))} />
        {hidden && <button type="button" className="chat-lightbox-spoiler" aria-label="Reveal spoiler" onClick={() => revealSpoiler(cur.id)}>SPOILER</button>}
        {i < images.length - 1 && <button type="button" className="chat-lightbox-nav next" aria-label="Next" onClick={() => go(i + 1)}><ArrowRight size={20} /></button>}
      </div>
      {images.length > 1 && <ul className="chat-lightbox-thumbs" aria-label="Images">
        {images.map((a, n) => <li key={a.id}><button type="button" className={n === i ? 'current' : undefined} aria-label={`Image ${n + 1} of ${images.length}${n === i ? ' (current)' : ''}`} onClick={() => go(n)}><img className={covered(a) ? 'spoiler' : undefined} src={resolveUrl(a.url)} alt="" draggable={false} /></button></li>)}
      </ul>}
    </div>
  </div>, document.body);
}
