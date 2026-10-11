// "Convert emoticons to emoji" (Settings > Appearance, on by default): applied to the text of a message when it is sent, never while typing.

const EMOTICONS: Record<string, string> = {
  ':)': '🙂', ':-)': '🙂',
  ':(': '🙁', ':-(': '🙁',
  ':D': '😃', ':-D': '😃',
  ';)': '😉', ';-)': '😉',
  ':P': '😛', ':p': '😛', ':-P': '😛', ':-p': '😛',
  ':O': '😮', ':o': '😮', ':-O': '😮', ':-o': '😮',
  ':|': '😐', ':-|': '😐',
  ':/': '😕', ':-/': '😕',
  ':*': '😗', ':-*': '😗',
  ":'(": '😢',
  '>:(': '😠',
  '<3': '❤️',
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first so ":-)" is not read as ":" + "-)"; an emoticon only counts when whitespace or a line boundary surrounds it.
const PATTERN = new RegExp(`(^|\\s)(${Object.keys(EMOTICONS).sort((a, b) => b.length - a.length).map(escape).join('|')})(?=\\s|$)`, 'g');
// Fenced blocks and inline code are left alone.
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

export function convertEmoticons(text: string): string {
  return text.split(CODE).map((part, i) => (i % 2 === 1 ? part : part.replace(PATTERN, (_m, lead: string, emo: string) => `${lead}${EMOTICONS[emo]}`))).join('');
}
