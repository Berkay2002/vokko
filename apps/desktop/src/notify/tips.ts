// Rotating tip line on the startup screen. Our own wording; every tip describes something the client really does.
// Keys go in {braces} as binding specs ("Mod+K") so they read as this OS labels them: ⌘K on macOS, {Mod+K} elsewhere.

import { IS_MAC, keyCaps } from "../keyboard";

export const TIPS: readonly string[] = [
  "Press {Mod+K} to jump to any channel or conversation.",
  "Press Escape in a channel to mark it as read.",
  "Press the Up arrow in an empty message box to edit your last message.",
  "Hold Shift and press Enter to start a new line without sending.",
  "Wrap text in ||two bars|| to hide it behind a spoiler.",
  "Start a line with > to quote, or with # for a heading.",
  "Press {Mod+/} to see every keyboard shortcut.",
  "{Alt+ArrowUp} and {Alt+ArrowDown} move between the channels of a server.",
  "{Mod+U} shows or hides the member list.",
  "Press {Mod+I} to open your inbox of mentions and unreads.",
  "Wrap code in `backticks`, or in three backticks for a code block.",
  "Everything that costs money elsewhere is free here, animated emoji included.",
];

/** A stable pick for `n` (tests and screenshots rely on this); the splash starts from a random `n`. */
export function tipAt(n: number, mac: boolean = IS_MAC): string {
  const length = TIPS.length;
  const tip = TIPS[((n % length) + length) % length] ?? "";
  return tip.replace(/\{([^}]+)\}/g, (_, spec: string) => keyCaps(spec, mac).join(mac ? "" : "+"));
}
