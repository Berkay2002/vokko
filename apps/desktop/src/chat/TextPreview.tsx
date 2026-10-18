import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Download, Maximize2 } from 'lucide-react';
import type { Attachment } from '../api/types';
import { highlightIfLoaded, useHighlighterLoaded } from './markdown/highlighter';
import { Modal, Tooltip, resolveUrl } from './shell';
import { formatBytes } from './util';
import { COLLAPSED_LINES, EXPANDED_LINES, PREVIEW_MAX_FILE, PREVIEW_PREFIX_BYTES, firstLines, languageOf, loadText, type LoadedText } from './textAttachment';

function useHighlighted(code: string, lang: string | null): ReactNode {
  const ready = useHighlighterLoaded();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (lang ? highlightIfLoaded(code, lang) : code), [code, lang, ready]);
}

/** True once the element has come within 200px of the viewport (stays true). */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setNear(true); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

/**
 * Inline preview of a text or code attachment: the first lines highlighted, Expand / Collapse, View whole file, download.
 * Shows `children` (the plain file card) until the text has loaded, and keeps it when the fetch fails or the file looks binary.
 */
export function TextPreview({ attachment, children }: { attachment: Attachment; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const near = useNearViewport(wrap);
  const url = resolveUrl(attachment.url);
  const [loaded, setLoaded] = useState<LoadedText | null | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (!near) return;
    let live = true;
    void loadText(url, PREVIEW_PREFIX_BYTES).then(v => { if (live) setLoaded(v); });
    return () => { live = false; };
  }, [near, url]);
  const lang = languageOf(attachment.filename);
  const { shown, total } = firstLines(loaded?.text ?? '', expanded ? EXPANDED_LINES : COLLAPSED_LINES);
  const body = useHighlighted(shown, lang);
  if (!loaded) return <div ref={wrap} className="chat-text-preview-slot">{children}</div>;
  const more = loaded.truncated || total > COLLAPSED_LINES;
  return <div ref={wrap} className={`chat-text-preview${expanded ? ' expanded' : ''}`}>
    <pre className="chat-text-preview-code" tabIndex={0} aria-label={`Preview of ${attachment.filename}`}><code className="hljs">{body}</code></pre>
    <div className="chat-text-preview-bar">
      {more && <button type="button" className="chat-text-preview-toggle" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}{expanded ? 'Collapse' : 'Expand'}
      </button>}
      <div className="chat-text-preview-meta">
        <a className="chat-file-name" href={url} target="_blank" rel="noopener noreferrer" title={attachment.filename}>{attachment.filename}</a>
        <span className="chat-file-size">{formatBytes(attachment.size)}</span>
      </div>
      <Tooltip content="View whole file" side="top">
        <button type="button" className="chat-text-preview-btn" aria-label="View whole file" onClick={() => setWhole(true)}><Maximize2 size={20} /></button>
      </Tooltip>
      <Tooltip content="Download" side="top">
        <a className="chat-text-preview-btn" href={url} download={attachment.filename} aria-label={`Download ${attachment.filename}`}><Download size={20} /></a>
      </Tooltip>
    </div>
    {whole && <WholeFile attachment={attachment} url={url} lang={lang} onClose={() => setWhole(false)} />}
  </div>;
}

function WholeFile({ attachment, url, lang, onClose }: { attachment: Attachment; url: string; lang: string | null; onClose(): void }) {
  const [file, setFile] = useState<LoadedText | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadText(url, PREVIEW_MAX_FILE).then(v => { if (live) setFile(v); });
    return () => { live = false; };
  }, [url]);
  const text = file ? firstLines(file.text, Number.MAX_SAFE_INTEGER) : null;
  const body = useHighlighted(text?.shown ?? '', lang);
  const gutter = useMemo(() => (text ? Array.from({ length: text.total }, (_, i) => i + 1).join('\n') : ''), [text?.total]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Modal open onClose={onClose} title={attachment.filename} className="modal-large chat-text-modal"
    footer={<a className="chat-btn primary" href={url} download={attachment.filename}><Download size={16} /> Download</a>}>
    {file === undefined && <p className="chat-text-modal-status">Loading…</p>}
    {file === null && <p className="chat-text-modal-status">This file can't be previewed.</p>}
    {text && <div className="chat-text-modal-code" tabIndex={0} role="region" aria-label={`Contents of ${attachment.filename}`}>
      <pre className="chat-text-modal-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="chat-text-modal-text"><code className="hljs">{body}</code></pre>
    </div>}
  </Modal>;
}
