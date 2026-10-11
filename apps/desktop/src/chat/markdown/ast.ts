/** AST for Discord-flavoured markdown. */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[]; masked: boolean } // masked = [text](url) form
  | { t: 'mention'; kind: 'user' | 'role' | 'channel'; id: string }
  | { t: 'everyone' }
  | { t: 'here' }
  | { t: 'timestamp'; unix: number; style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' } // <t:unix> defaults to 'f'
  | { t: 'emoji'; unicode: string; name?: string } // unicode emoji or resolved :shortcode:
  | { t: 'customEmoji'; name: string; id: string; animated: boolean } // <:name:id> / <a:name:id>
  | { t: 'br' };

export type Block =
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'heading'; level: 1 | 2 | 3; c: Inline[] } // "# " "## " "### " at line start
  | { t: 'subtext'; c: Inline[] } // "-# " at line start
  | { t: 'codeblock'; lang: string | null; v: string } // ```lang\n...\n```
  | { t: 'quote'; c: Block[] } // "> " per line, or ">>> " swallowing the rest of the message
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }; // "- " / "* " / "1. " lines

export interface ParseOptions {
  /** shortcode name (no colons) -> unicode */
  emojiShortcodes?: ReadonlyMap<string, string>;
}
