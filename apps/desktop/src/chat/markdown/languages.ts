// Fence language names and header labels. Kept apart from the grammars (highlight.ts, loaded lazily) so a code block can show its
// label on first paint.

/** canonical name -> label shown in the code-block header */
export const LABELS: Readonly<Record<string, string>> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'HTML',
  yaml: 'YAML',
};

const ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  golang: 'go',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  jsonc: 'json',
};

/** Canonical grammar name for a fence language, or null when it is unknown / plain. */
export function resolveLanguage(lang: string | null): string | null {
  if (!lang) return null;
  const lc = lang.trim().toLowerCase();
  const canonical = Object.prototype.hasOwnProperty.call(ALIASES, lc) ? ALIASES[lc]! : lc;
  return Object.prototype.hasOwnProperty.call(LABELS, canonical) ? canonical : null;
}

/** Label for the code-block header, or null when the language is unknown. */
export function languageLabel(lang: string | null): string | null {
  const canonical = resolveLanguage(lang);
  return canonical ? LABELS[canonical]! : null;
}
