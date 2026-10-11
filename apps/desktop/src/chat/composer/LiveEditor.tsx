import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react';
import { useChat } from '../ChatContext';
import { defaultFormatTimestamp, type MarkdownContext } from '../markdown';
import { highlightRanges } from './codeHighlight';
import { domToOffset, offsetToDom, readSource, walkOffset, type DomNode } from './domMap';
import { applyInput, type EditResult, type Selection } from './edit';
import { EditHistory } from './history';
import { atomRanges, LineFlag, Mark, tokenize, type Atom, type EditorLine, type Segment } from './tokenize';
import './composer.css';

/** What the composer needs from its input element: the part of the <textarea> API it uses. A <textarea> satisfies it as is. */
export interface ComposerField {
  focus(): void;
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

export interface LiveEditorProps {
  fieldRef: Ref<ComposerField>;
  value: string;
  onChange(value: string): void;
  placeholder: string;
  /** Display forms of mentions picked from the autocomplete (`@Alice`), shown as chips. */
  mentions: readonly string[];
  /** The draft's identity (the channel): the undo history starts over when it changes. */
  resetKey: string;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
  onPaste?(event: ClipboardEvent<HTMLElement>): void;
  /** The caret moved (selection start). */
  onCaret?(offset: number): void;
}

// ---- DOM rendering -----------------------------------------------------------------------------------------------------------------

const MARK_CLASSES: readonly [number, string][] = [
  [Mark.Bold, 'le-b'],
  [Mark.Italic, 'le-i'],
  [Mark.Underline, 'le-u'],
  [Mark.Strike, 'le-s'],
  [Mark.Spoiler, 'le-sp'],
  [Mark.Code, 'le-c'],
  [Mark.Syntax, 'le-syn'],
  [Mark.Link, 'le-link'],
  [Mark.Mention, 'le-men'],
  [Mark.Emoji, 'le-emo'],
  [Mark.QuoteMark, 'le-qm'],
];

function markClasses(marks: number): string {
  let out = '';
  for (const [bit, cls] of MARK_CLASSES) if (marks & bit) out += ` ${cls}`;
  return out.trim();
}

function lineClasses(flags: number): string {
  let out = 'le-line';
  if (flags & LineFlag.Quote) out += ' le-quote';
  if (flags & LineFlag.QuoteBody) out += ' le-quote-body';
  if (flags & LineFlag.Code) out += ' le-code-line';
  if (flags & LineFlag.Subtext) out += ' le-sub';
  if (flags & LineFlag.List) out += ' le-list';
  if (flags & LineFlag.Heading) out += ' le-head';
  return out;
}

function atomLabel(atom: Atom, md: MarkdownContext): string {
  switch (atom.kind) {
    case 'user':
      return `@${md.userName(atom.id) ?? 'unknown-user'}`;
    case 'role':
      return `@${md.roleInfo(atom.id)?.name ?? 'unknown-role'}`;
    case 'channel':
      return `#${md.channelName(atom.id) ?? 'unknown-channel'}`;
    case 'emoji':
      return `:${atom.name}:`;
    case 'timestamp':
      return (md.formatTimestamp ?? defaultFormatTimestamp)(atom.unix, atom.style).text;
    case 'shortcode':
      return atom.unicode;
  }
}

function lineSignature(source: string, line: EditorLine, md: MarkdownContext): string {
  const segs = line.segments.map(s => `${s.start}.${s.end}.${s.marks}.${s.hl ?? ''}${s.atom ? `.${atomLabel(s.atom, md)}` : ''}`).join('|');
  return `${line.flags}:${line.start}:${source.slice(line.start, line.end)}:${segs}`;
}

function buildSegment(source: string, seg: Segment, md: MarkdownContext): HTMLElement {
  const el = document.createElement('span');
  el.dataset.o = String(seg.start);
  el.dataset.e = String(seg.end);
  if (!seg.atom) {
    el.className = [markClasses(seg.marks), seg.hl ?? ''].filter(Boolean).join(' ');
    el.textContent = source.slice(seg.start, seg.end);
    return el;
  }
  el.className = `le-atom le-atom-${seg.atom.kind === 'timestamp' || seg.atom.kind === 'shortcode' || seg.atom.kind === 'emoji' ? seg.atom.kind : 'mention'} ${markClasses(seg.marks)}`.trim();
  el.contentEditable = 'false';
  el.dataset.atom = seg.atom.kind;
  el.dataset.raw = source.slice(seg.start, seg.end);
  if (seg.atom.kind === 'emoji') {
    const img = document.createElement('img');
    img.className = 'le-emoji-img';
    img.alt = `:${seg.atom.name}:`;
    img.draggable = false;
    const url = md.customEmojiUrl?.(seg.atom.id, seg.atom.animated);
    if (url) img.src = url;
    el.title = `:${seg.atom.name}:`;
    el.appendChild(img);
  } else {
    el.textContent = atomLabel(seg.atom, md);
  }
  return el;
}

function buildLine(source: string, line: EditorLine, md: MarkdownContext, sig: string): HTMLElement {
  const el = document.createElement('div');
  el.className = lineClasses(line.flags);
  el.dataset.ls = String(line.start);
  el.dataset.le = String(line.end);
  el.dataset.sig = sig;
  for (const seg of line.segments) el.appendChild(buildSegment(source, seg, md));
  // an empty line, or one that ends in a chip, needs a trailing <br> so the caret has somewhere to stand
  const last = line.segments[line.segments.length - 1];
  if (!last || last.atom) el.appendChild(document.createElement('br'));
  return el;
}

/** Bring the DOM in line with `lines`, rebuilding only the lines whose signature changed. Returns whether anything changed. */
function syncDom(root: HTMLElement, source: string, lines: EditorLine[], md: MarkdownContext, force: boolean): boolean {
  let changed = false;
  if (force) {
    root.replaceChildren();
    changed = true;
  }
  lines.forEach((line, i) => {
    const sig = lineSignature(source, line, md);
    const existing = root.children[i] as HTMLElement | undefined;
    if (existing && existing.dataset.sig === sig) return;
    const next = buildLine(source, line, md, sig);
    if (existing) existing.replaceWith(next);
    else root.appendChild(next);
    changed = true;
  });
  while (root.children.length > lines.length) {
    root.lastElementChild?.remove();
    changed = true;
  }
  return changed;
}

// ---- selection ---------------------------------------------------------------------------------------------------------------------

function readSelection(root: HTMLElement, stale = false): Selection | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const map = stale ? walkOffset : domToOffset;
  const a = map(root as unknown as DomNode, sel.anchorNode as unknown as DomNode, sel.anchorOffset);
  const f = map(root as unknown as DomNode, sel.focusNode as unknown as DomNode, sel.focusOffset);
  return { start: Math.min(a, f), end: Math.max(a, f) };
}

function setSelection(root: HTMLElement, start: number, end: number): void {
  const sel = document.getSelection();
  if (!sel) return;
  const a = offsetToDom(root as unknown as DomNode, start);
  const b = start === end ? a : offsetToDom(root as unknown as DomNode, end);
  try {
    sel.setBaseAndExtent(a.node as unknown as Node, a.offset, b.node as unknown as Node, b.offset);
  } catch {
    /* the DOM moved under us; the next render sets it again */
  }
}

/** Scroll the (growing, max 50vh) editor so the caret stays in view. */
function revealCaret(root: HTMLElement): void {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  let rect = range.getBoundingClientRect();
  if (rect.height === 0) {
    const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    if (node) rect = node.getBoundingClientRect();
  }
  const box = root.getBoundingClientRect();
  if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom + 4;
  else if (rect.top < box.top) root.scrollTop -= box.top - rect.top + 4;
}

/** Plain text of a clipboard or drop payload; HTML-only payloads (no text/plain) fall back to the HTML's text. */
function plainText(dt: DataTransfer | null | undefined): string | null {
  if (!dt) return null;
  const text = dt.getData('text/plain');
  if (text) return text;
  const html = dt.getData('text/html');
  if (!html) return null;
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

/** The DOM boundary point under a viewport position (Chrome: caretRangeFromPoint; the standard caretPositionFromPoint otherwise). */
function pointAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null;
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  const pos = doc.caretPositionFromPoint?.(x, y);
  return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
}

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

// ---- component ---------------------------------------------------------------------------------------------------------------------

/**
 * The composer's input when "Preview markdown as you type" is on: a contenteditable whose model is the source string. Every edit goes
 * through `beforeinput` (cancelled and applied by `applyInput`), the DOM is rendered from the tokenizer, and undo/redo are our own.
 * IME composition is the exception: the browser edits the DOM and the text is read back when the composition ends.
 */
export function LiveEditor({ fieldRef, value, onChange, placeholder, mentions, resetKey, onKeyDown, onPaste, onCaret }: LiveEditorProps) {
  const chat = useChat();
  const rootRef = useRef<HTMLDivElement>(null);
  const state = useRef({ value, sel: { start: value.length, end: value.length } as Selection, composing: false, atoms: [] as [number, number][], rendered: false });
  const history = useRef(new EditHistory());
  const live = useRef({ onChange, onCaret, md: chat.md, mentions });
  useLayoutEffect(() => {
    live.current = { onChange, onCaret, md: chat.md, mentions };
  });

  /** Tokenize and sync the DOM. Returns whether the DOM changed. */
  const render = useCallback((force = false): boolean => {
    const root = rootRef.current;
    if (!root) return false;
    const { md, mentions: picked } = live.current;
    const source = state.current.value;
    const lines = tokenize(source, { shortcodes: md.emojiShortcodes, mentions: picked, highlight: highlightRanges });
    state.current.atoms = atomRanges(lines);
    const changed = syncDom(root, source, lines, md, force);
    root.dataset.empty = source === '' ? 'true' : 'false';
    state.current.rendered = true;
    return changed;
  }, []);

  const renderKeepingSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const focused = document.activeElement === root;
    const sel = focused ? readSelection(root) : null;
    if (render() && sel) setSelection(root, sel.start, sel.end);
  }, [render]);

  /** Make `next` the editor's content and selection, then tell the composer. */
  const commit = useCallback(
    (next: { value: string; start: number; end: number }, notify = true) => {
      const root = rootRef.current;
      if (!root) return;
      const s = state.current;
      s.value = next.value;
      s.sel = { start: next.start, end: next.end };
      render();
      setSelection(root, next.start, next.end);
      revealCaret(root);
      if (notify) live.current.onChange(next.value);
      live.current.onCaret?.(next.start);
    },
    [render],
  );

  const applyEdit = useCallback(
    (result: EditResult, before: Selection) => {
      const s = state.current;
      history.current.record({ value: s.value, start: before.start, end: before.end }, { value: result.value, start: result.start, end: result.end }, result.kind, Date.now());
      commit(result);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const snap = history.current.undo();
    if (snap) commit(snap);
  }, [commit]);
  const redo = useCallback(() => {
    const snap = history.current.redo();
    if (snap) commit(snap);
  }, [commit]);

  /** The browser edited the DOM (IME, or an edit we could not cancel): take its text as the new source. */
  const syncFromDom = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const s = state.current;
    const text = readSource(root as unknown as DomNode).replace(/\r\n?/g, '\n');
    const sel = readSelection(root, true) ?? { start: text.length, end: text.length };
    if (text !== s.value) history.current.record({ value: s.value, start: s.sel.start, end: s.sel.end }, { value: text, start: sel.start, end: sel.end }, 'other', Date.now());
    s.value = text;
    s.sel = sel;
    render(true);
    setSelection(root, sel.start, sel.end);
    revealCaret(root);
    live.current.onChange(text);
    live.current.onCaret?.(sel.start);
  }, [render]);

  // first paint, and whenever the draft changes from outside (send, autocomplete, channel switch)
  useLayoutEffect(() => {
    const s = state.current;
    const text = normalizeNewlines(value);
    if (s.rendered && text === s.value) return;
    s.value = text;
    history.current.clear();
    render(true);
    // the caret goes to the end of the new text; focus() puts it there when the editor is not focused right now
    s.sel = { start: text.length, end: text.length };
    const root = rootRef.current;
    if (root && document.activeElement === root) setSelection(root, text.length, text.length);
  }, [value, render]);

  const mentionsKey = mentions.join('\u0000');
  useLayoutEffect(() => {
    renderKeepingSelection();
  }, [chat.md, mentionsKey, renderKeepingSelection]);

  useEffect(() => {
    history.current.clear();
  }, [resetKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const s = state.current;

    const onBeforeInput = (e: InputEvent) => {
      const type = e.inputType;
      if (s.composing || e.isComposing || type === 'insertCompositionText' || type === 'deleteCompositionText' || type === 'insertFromComposition') return;
      e.preventDefault();
      if (type === 'historyUndo') return undo();
      if (type === 'historyRedo') return redo();
      const sel = readSelection(root) ?? s.sel;
      const data = e.data ?? plainText(e.dataTransfer);
      let range: Selection | undefined;
      if (type === 'insertReplacementText' || type === 'insertFromDrop') {
        const target = e.getTargetRanges()[0];
        if (target) {
          const a = domToOffset(root as unknown as DomNode, target.startContainer as unknown as DomNode, target.startOffset);
          const b = domToOffset(root as unknown as DomNode, target.endContainer as unknown as DomNode, target.endOffset);
          range = { start: Math.min(a, b), end: Math.max(a, b) };
        }
      }
      const result = applyInput(s.value, sel, type, data, s.atoms, range);
      if (result) applyEdit(result, sel);
    };
    const onInput = (e: Event) => {
      // only reached for edits beforeinput could not cancel
      if (s.composing || (e as InputEvent).isComposing) return;
      if (readSource(root as unknown as DomNode) !== s.value) syncFromDom();
    };
    const onCompositionStart = () => {
      s.composing = true;
    };
    const onCompositionEnd = () => {
      s.composing = false;
      syncFromDom();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing || s.composing) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!mod || e.altKey) return;
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y' && !e.metaKey) {
        e.preventDefault();
        redo();
      }
    };
    const onCopyCut = (e: globalThis.ClipboardEvent) => {
      const sel = readSelection(root);
      if (!sel || sel.start === sel.end || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', s.value.slice(sel.start, sel.end));
      if (e.type === 'cut') {
        const result = applyInput(s.value, sel, 'deleteByCut', null, s.atoms);
        if (result) applyEdit(result, sel);
      }
    };
    // Dragging text inside the editor: the browser's own drop would fire deleteByDrag + insertFromDrop, and cancelling the first makes it
    // skip the second. So the whole move is done here, on drop, as one undo entry.
    let dragged: Selection | null = null;
    const onDragStart = () => {
      const sel = readSelection(root);
      dragged = sel && sel.start !== sel.end ? sel : null;
    };
    const onDragEnd = () => {
      dragged = null;
    };
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt && dt.files.length > 0) return; // file drops belong to the composer's attach handling
      e.preventDefault();
      const internal = dragged;
      dragged = null;
      const moving = internal && dt?.dropEffect !== 'copy' ? internal : null;
      const text = normalizeNewlines(internal ? s.value.slice(internal.start, internal.end) : (plainText(dt) ?? ''));
      if (text === '') return;
      const point = pointAt(e.clientX, e.clientY);
      let at = point && root.contains(point.node) ? domToOffset(root as unknown as DomNode, point.node as unknown as DomNode, point.offset) : s.value.length;
      for (const [a, b] of s.atoms) if (at > a && at < b) at = at - a < b - at ? a : b;
      const before = readSelection(root) ?? s.sel;
      let value = s.value;
      if (moving) {
        if (at >= moving.start && at <= moving.end) return; // dropped onto itself
        value = value.slice(0, moving.start) + value.slice(moving.end);
        if (at > moving.end) at -= moving.end - moving.start;
      }
      value = value.slice(0, at) + text + value.slice(at);
      root.focus();
      applyEdit({ value, start: at, end: at + text.length, kind: 'other' }, before);
    };
    const onSelectionChange = () => {
      if (s.composing || document.activeElement !== root) return;
      const sel = readSelection(root);
      if (!sel) return;
      s.sel = sel;
      live.current.onCaret?.(sel.start);
    };
    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('input', onInput);
    root.addEventListener('compositionstart', onCompositionStart);
    root.addEventListener('compositionend', onCompositionEnd);
    root.addEventListener('keydown', onKey);
    root.addEventListener('copy', onCopyCut);
    root.addEventListener('cut', onCopyCut);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('drop', onDrop);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('input', onInput);
      root.removeEventListener('compositionstart', onCompositionStart);
      root.removeEventListener('compositionend', onCompositionEnd);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('copy', onCopyCut);
      root.removeEventListener('cut', onCopyCut);
      root.removeEventListener('dragstart', onDragStart);
      root.removeEventListener('dragend', onDragEnd);
      root.removeEventListener('drop', onDrop);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [applyEdit, redo, syncFromDom, undo]);

  useImperativeHandle(
    fieldRef,
    () => {
      const current = (): Selection => {
        const root = rootRef.current;
        return (root && document.activeElement === root ? readSelection(root) : null) ?? state.current.sel;
      };
      return {
        focus: () => {
          const root = rootRef.current;
          if (!root) return;
          const wasFocused = document.activeElement === root;
          root.focus();
          // a programmatic focus would leave the caret at the start: bring back the saved selection (the end of the text if none)
          if (!wasFocused) {
            const { sel, value } = state.current;
            const a = Math.min(sel.start, value.length);
            setSelection(root, a, Math.max(a, Math.min(sel.end, value.length)));
          }
        },
        get value() {
          return state.current.value;
        },
        get selectionStart() {
          return current().start;
        },
        get selectionEnd() {
          return current().end;
        },
        setSelectionRange: (start: number, end: number) => {
          const root = rootRef.current;
          const max = state.current.value.length;
          const a = Math.max(0, Math.min(start, max));
          const b = Math.max(a, Math.min(end, max));
          state.current.sel = { start: a, end: b };
          if (root) setSelection(root, a, b);
          live.current.onCaret?.(a);
        },
      };
    },
    [],
  );

  return (
    <div
      ref={rootRef}
      className="chat-textarea chat-live"
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      data-empty="true"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}
