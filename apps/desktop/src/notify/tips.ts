// Rotating tip line on the startup screen. Our own wording; every tip describes something the client really does.

export const TIPS: readonly string[] = [
  "Press Ctrl+K to jump to any channel or conversation.",
  "Press Escape in a channel to mark it as read.",
  "Press the Up arrow in an empty message box to edit your last message.",
  "Hold Shift and press Enter to start a new line without sending.",
  "Wrap text in ||two bars|| to hide it behind a spoiler.",
  "Start a line with > to quote, or with # for a heading.",
  "Press Ctrl+/ to see every keyboard shortcut.",
  "Alt+Up and Alt+Down move between the channels of a server.",
  "Ctrl+U shows or hides the member list.",
  "Press Ctrl+I to open your inbox of mentions and unreads.",
  "Wrap code in `backticks`, or in three backticks for a code block.",
  "Everything that costs money elsewhere is free here, animated emoji included.",
];

/** A stable pick for `n` (tests and screenshots rely on this); the splash starts from a random `n`. */
export function tipAt(n: number): string {
  const length = TIPS.length;
  return TIPS[((n % length) + length) % length] ?? "";
}
