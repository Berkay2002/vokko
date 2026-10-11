import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, File as FileIcon, FileArchive, FileAudio, FileCode, FileText, FileVideo, X } from 'lucide-react';
import type { Attachment, Message } from '../api/types';
import { useChat } from './ChatContext';
import { formatBytes } from './util';

export const isImage = (a: Attachment): boolean => !!a.content_type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(a.filename);
const isVideo = (a: Attachment): boolean => !!a.content_type?.startsWith('video/');

const MAX_SINGLE_W = 400;
const MAX_SINGLE_H = 300;

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
  const [spoiled, setSpoiled] = useState(false);
  const spoiler = attachment.filename.startsWith('SPOILER_') && !spoiled;
  return <button type="button" className={`chat-image${className ? ` ${className}` : ''}${spoiler ? ' spoiler' : ''}`} style={style} aria-label={`Open image ${attachment.filename}`}
    onClick={() => (spoiler ? setSpoiled(true) : chat.actions.openImage(message, index))}>
    <img src={attachment.url} alt={attachment.filename} loading="lazy" draggable={false} />
    {spoiler && <span className="chat-image-spoiler-label">SPOILER</span>}
  </button>;
}

/** Discord-style layouts: 1 single, 2 side by side, 3 one tall + two stacked, 4 grid, 5 two over three, 6+ rows of three. */
function ImageGrid({ message, images }: { message: Message; images: { a: Attachment; index: number }[] }) {
  if (images.length === 1) {
    const { a, index } = images[0]!;
    const w = a.width ?? MAX_SINGLE_W, h = a.height ?? MAX_SINGLE_H;
    const scale = Math.min(1, MAX_SINGLE_W / w, MAX_SINGLE_H / h);
    const width = Math.max(40, Math.round(w * scale)), height = Math.max(40, Math.round(h * scale));
    return <div className="chat-image-grid single"><ImageTile message={message} attachment={a} index={index} style={{ width, height }} /></div>;
  }
  const n = Math.min(images.length, 10);
  const shown = images.slice(0, n);
  const rows: number[] = n === 2 ? [2] : n === 3 ? [1, 2] : n === 4 ? [2, 2] : n === 5 ? [2, 3] : n === 6 ? [3, 3] : n === 7 ? [1, 3, 3] : n === 8 ? [2, 3, 3] : n === 9 ? [3, 3, 3] : [1, 3, 3, 3];
  let cursor = 0;
  return <div className="chat-image-grid multi" data-count={n}>
    {rows.map((count, ri) => {
      const slice = shown.slice(cursor, cursor + count);
      cursor += count;
      return <div className="chat-image-row" key={ri} style={{ height: n === 3 && ri === 0 ? 220 : 160 }}>
        {slice.map(({ a, index }) => <ImageTile key={a.id} message={message} attachment={a} index={index} className="fill" />)}
      </div>;
    })}
  </div>;
}

export function Attachments({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null;
  const images: { a: Attachment; index: number }[] = [];
  const others: Attachment[] = [];
  message.attachments.forEach((a, index) => { if (isImage(a)) images.push({ a, index }); else others.push(a); });
  return <div className="chat-attachments">
    {images.length > 0 && <ImageGrid message={message} images={images} />}
    {others.map(a => isVideo(a)
      ? <video key={a.id} className="chat-video" src={a.url} controls preload="metadata" />
      : <FileCard key={a.id} attachment={a} />)}
  </div>;
}

export function FileCard({ attachment }: { attachment: Attachment }) {
  const Icon = fileIcon(attachment);
  return <div className="chat-file">
    <Icon className="chat-file-icon" size={40} aria-hidden="true" />
    <div className="chat-file-meta">
      <a className="chat-file-name" href={attachment.url} target="_blank" rel="noopener noreferrer" title={attachment.filename}>{attachment.filename}</a>
      <span className="chat-file-size">{formatBytes(attachment.size)}</span>
    </div>
    <a className="chat-file-download" href={attachment.url} download={attachment.filename} aria-label={`Download ${attachment.filename}`} title="Download"><Download size={24} /></a>
  </div>;
}

export function Lightbox({ message, index, onClose }: { message: Message; index: number; onClose: () => void }) {
  const images = message.attachments.filter(isImage);
  const start = Math.max(0, images.findIndex(a => a.id === message.attachments[index]?.id));
  const [i, setI] = useState(start);
  const cur = images[i];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setI(v => Math.max(0, v - 1));
      else if (e.key === 'ArrowRight') setI(v => Math.min(images.length - 1, v + 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [images.length, onClose]);
  if (!cur) return null;
  return createPortal(<div className="chat-lightbox" role="dialog" aria-modal="true" aria-label={cur.filename} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <button type="button" className="chat-lightbox-close" aria-label="Close" onClick={onClose}><X size={28} /></button>
    {i > 0 && <button type="button" className="chat-lightbox-nav prev" aria-label="Previous image" onClick={() => setI(i - 1)}><ChevronLeft size={36} /></button>}
    {i < images.length - 1 && <button type="button" className="chat-lightbox-nav next" aria-label="Next image" onClick={() => setI(i + 1)}><ChevronRight size={36} /></button>}
    <figure className="chat-lightbox-figure">
      <img src={cur.url} alt={cur.filename} draggable={false} />
      <figcaption><a href={cur.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open in Browser</a></figcaption>
    </figure>
  </div>, document.body);
}
