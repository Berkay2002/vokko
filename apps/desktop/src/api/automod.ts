// AutoMod keyword matching (docs/api.md "AutoMod"), the same rules as the server's `safety::find_keyword`.
// Case-insensitive whole words; `*` at the start / end of a keyword lets it extend into the word (prefix, suffix, substring).

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
