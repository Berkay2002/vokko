import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react';
import { usePrefs } from '../../ui';
import { LiveEditor, type ComposerField } from './LiveEditor';

export type { ComposerField } from './LiveEditor';

export interface ComposerInputProps {
  fieldRef: Ref<ComposerField>;
  value: string;
  onChange(value: string): void;
  placeholder: string;
  /** Display forms of the mentions picked from the autocomplete (`@Alice`). */
  mentions: readonly string[];
  /** Identity of the draft (the channel id): the editor's undo history starts over when it changes. */
  resetKey: string;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onPaste(event: ClipboardEvent<HTMLElement>): void;
  onCaret(offset: number): void;
}

/** The composer's text input: the styled live editor, or a plain <textarea> when "Preview Markdown as you type" is off. */
export function ComposerInput(props: ComposerInputProps) {
  const live = usePrefs(s => s.previewMarkdown);
  return live ? <LiveEditor {...props} /> : <PlainInput {...props} />;
}

function PlainInput({ fieldRef, value, onChange, placeholder, onKeyDown, onPaste, onCaret }: ComposerInputProps) {
  const el = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, Math.round(window.innerHeight * 0.5))}px`;
  }, [value]);

  const setRef = (node: HTMLTextAreaElement | null) => {
    el.current = node;
    if (typeof fieldRef === 'function') fieldRef(node);
    else if (fieldRef) (fieldRef as { current: ComposerField | null }).current = node;
  };

  return (
    <textarea
      ref={setRef}
      className="chat-textarea"
      rows={1}
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      spellCheck
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onSelect={e => onCaret(e.currentTarget.selectionStart)}
      onClick={e => onCaret(e.currentTarget.selectionStart)}
    />
  );
}
