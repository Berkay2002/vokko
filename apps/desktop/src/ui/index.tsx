// STUB (vokko-chat): minimal primitives with shell's contract signatures. Dropped at milestone A merge.
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return <span style={{ display: 'contents' }} onMouseOver={e => setRect((e.target as HTMLElement).getBoundingClientRect())} onMouseOut={() => setRect(null)}>
    {children}
    {rect && createPortal(<div role="tooltip" style={{ position: 'fixed', left: rect.left + rect.width / 2, top: rect.top - 8, transform: 'translate(-50%,-100%)', background: '#111214', color: '#dbdee1', padding: '8px 12px', borderRadius: 5, fontSize: 14, zIndex: 9000, pointerEvents: 'none' }}>{content}</div>, document.body)}
  </span>;
}

export type MenuItem =
  | { type: 'separator' }
  | { id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect?: () => void; children?: MenuItem[] };

interface MenuState { x: number; y: number; items: MenuItem[] }
let setGlobal: ((s: MenuState | null) => void) | null = null;

export function useContextMenu() {
  return {
    open: (event: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => { event.preventDefault(); setGlobal?.({ x: event.clientX, y: event.clientY, items }); },
    close: () => setGlobal?.(null),
  };
}
export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => { setGlobal = setMenu; return () => { setGlobal = null; }; }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [menu]);
  if (!menu) return null;
  return createPortal(<div role="menu" onMouseDown={e => e.stopPropagation()} style={{ position: 'fixed', left: menu.x, top: menu.y, minWidth: 188, background: '#111214', borderRadius: 4, padding: 8, zIndex: 9000, color: '#dbdee1', fontSize: 14 }}>
    {menu.items.map((it, i) => 'type' in it ? <div key={i} style={{ height: 1, background: '#2e2f34', margin: '4px' }} /> :
      <div key={it.id} role="menuitem" aria-disabled={it.disabled} style={{ padding: '6px 8px', borderRadius: 2, cursor: 'pointer', color: it.danger ? '#f23f42' : undefined, opacity: it.disabled ? .5 : 1 }}
        onClick={() => { if (it.disabled) return; setMenu(null); it.onSelect?.(); }}>{it.label}</div>)}
  </div>, document.body);
}

export function Popout({ anchor, open, onClose, children }: { anchor: RefObject<HTMLElement | null> | HTMLElement | null; open: boolean; onClose: () => void; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ right: 0, top: 0 });
  const close = useCallback(onClose, [onClose]);
  useEffect(() => {
    if (!open) return;
    const el = anchor && 'current' in anchor ? anchor.current : anchor;
    const r = el?.getBoundingClientRect();
    if (r) setPos({ right: r.right, top: r.bottom + 8 });
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const t = setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open, anchor, close]);
  if (!open) return null;
  return createPortal(<div ref={ref} style={{ position: 'fixed', right: window.innerWidth - pos.right, top: pos.top, zIndex: 8000 }}>{children}</div>, document.body);
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(<div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'grid', placeItems: 'center', zIndex: 9500 }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" style={{ width: 440, background: '#313338', color: '#dbdee1', borderRadius: 4 }}>
      {title && <div style={{ padding: 16, fontSize: 20, fontWeight: 600 }}>{title}</div>}
      <div style={{ padding: '0 16px 16px' }}>{children}</div>
      {footer && <div style={{ padding: 16, background: '#2b2d31', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
    </div>
  </div>, document.body);
}
