# AutoMod keyword presets

Word lists for the "Block Commonly Flagged Words" rule (trigger type 4, KEYWORD_PRESET). They were written for Vokko
by hand, are short on purpose, and use the same licence as the rest of the repository; no third-party list was copied.

One keyword per line, same syntax as a custom keyword rule: case-insensitive whole words, `*` at the start or end
lets the keyword extend into a longer word. Lines starting with `#` and blank lines are ignored.

The server (`crates/server/src/safety.rs`) and the browser mock (`apps/desktop/src/api/automod.ts`) both read these
files at build time, so a change here needs a rebuild of both. Server admins exempt words with the rule's allow list.
