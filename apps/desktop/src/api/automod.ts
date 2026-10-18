// AutoMod keyword matching (docs/api.md "AutoMod"), the same rules as the server's `safety::find_keyword`.
// Case-insensitive whole words; `*` at the start / end of a keyword lets it extend into the word (prefix, suffix, substring).

import profanity from "../../../../assets/automod/profanity.txt?raw";
import sexual from "../../../../assets/automod/sexual.txt?raw";
import slurs from "../../../../assets/automod/slurs.txt?raw";

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

interface Pattern {
  core: string[];
  left: boolean;
  right: boolean;
}

function pattern(keyword: string): Pattern {
  const lower = keyword.trim().toLowerCase();
  const left = lower.startsWith("*");
  const right = lower.length > 1 && lower.endsWith("*");
  return { core: [...lower.replace(/^\*+|\*+$/g, "")], left, right };
}

function wholeMatch(word: string[], allowed: string): boolean {
  const { core, left, right } = pattern(allowed);
  if (core.length === 0 || core.length > word.length) return false;
  const text = word.join("");
  const needle = core.join("");
  if (!left && !right) return text === needle;
  if (!left) return text.startsWith(needle);
  if (!right) return text.endsWith(needle);
  return text.includes(needle);
}

function matchesIn(text: string[], keyword: string, allowList: readonly string[]): boolean {
  const { core, left, right } = pattern(keyword);
  if (core.length === 0 || core.length > text.length) return false;
  for (let start = 0; start + core.length <= text.length; start += 1) {
    const end = start + core.length;
    if (core.some((c, i) => text[start + i] !== c)) continue;
    const boundedLeft = start === 0 || !isWord(text[start - 1]) || !isWord(core[0]);
    const boundedRight = end === text.length || !isWord(text[end]) || !isWord(core[core.length - 1]);
    if (!(left || boundedLeft) || !(right || boundedRight)) continue;
    let wordStart = start;
    while (wordStart > 0 && isWord(text[wordStart - 1])) wordStart -= 1;
    let wordEnd = end;
    while (wordEnd < text.length && isWord(text[wordEnd])) wordEnd += 1;
    const word = text.slice(wordStart, wordEnd);
    if (!allowList.some(allowed => wholeMatch(word, allowed))) return true;
  }
  return false;
}

/** The first keyword that blocks `content`, or null. */
export function findKeyword(content: string, keywords: readonly string[], allowList: readonly string[] = []): string | null {
  const text = [...content.toLowerCase()];
  return keywords.find(keyword => matchesIn(text, keyword, allowList)) ?? null;
}

const parsePreset = (text: string): string[] =>
  text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

/** The built-in KEYWORD_PRESET lists (assets/automod, shared with the server), by preset number (1 profanity, 2 sexual content, 3 slurs). */
export const PRESET_WORDS: Readonly<Record<number, readonly string[]>> = {
  1: parsePreset(profanity),
  2: parsePreset(sexual),
  3: parsePreset(slurs),
};

/** Unique user and role mentions in `content`, like the server's MENTION_SPAM count (`@everyone` does not count). */
export function mentionCount(content: string): number {
  const ids = new Set<string>();
  for (const match of content.matchAll(/<@([!&]?)(\d+)>/g)) ids.add(`${match[1] === "&" ? "r" : "u"}${match[2]}`);
  return ids.size;
}
