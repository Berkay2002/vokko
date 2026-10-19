import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { messagePathOf } from '../../shell/nav';

const go = vi.hoisted(() => vi.fn());
vi.mock('../shell', () => ({ go, messagePathOf: (href: string) => messagePathOf(href, ['https://chat.test']) }));
// InlineMarkdown is called as a plain function here, outside a renderer.
vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()), useMemo: (f: () => unknown) => f() }));

const { InlineMarkdown } = await import('./render');

type AnchorProps = { href: string; onClick: (e: object) => void };
function anchor(node: ReactNode): ReactElement<AnchorProps> | null {
  if (Array.isArray(node)) return node.map(anchor).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === 'a' ? (node as ReactElement<AnchorProps>) : anchor(node.props.children);
}

function click(content: string, onLink: (href: string) => void) {
  const a = anchor(InlineMarkdown({ content, ctx: { userName: () => null, roleInfo: () => null, channelName: () => null, currentUserId: null, onLink } }));
  const preventDefault = vi.fn();
  a!.props.onClick({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault });
  return preventDefault;
}

describe('Markdown link clicks', () => {
  it('a message link of this app opens in the app even when onLink is set', () => {
    go.mockClear();
    const onLink = vi.fn();
    expect(click('https://chat.test/channels/1/2/3', onLink)).toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/channels/1/2/3');
    expect(onLink).not.toHaveBeenCalled();
  });

  it('any other link still goes to onLink', () => {
    go.mockClear();
    const onLink = vi.fn();
    click('https://evil.example/channels/1/2/3', onLink);
    expect(onLink).toHaveBeenCalledWith('https://evil.example/channels/1/2/3');
    expect(go).not.toHaveBeenCalled();
  });
});
