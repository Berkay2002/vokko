// Keyboard movement between and inside the shell's regions. F6 / Shift+F6 cycle the server rail, the channel list, the chat and
// the member list (Discord has no documented region key; F6 is the browser and Slack convention). Up/Down/Home/End move between
// the rows of the rail, the channel or DM list and the member list while a row has focus; Tab still walks every control.

interface Region {
  box: string;
  /** Where focus lands when the region is entered: the first selector that matches, else the first focusable control. */
  start: string[];
  /** Inner regions of their own, skipped when looking for this region's controls. */
  not?: string;
}

const REGIONS: Region[] = [
  { box: ".server-rail", start: [".rail-item[data-state=selected] .rail-tile"] },
  { box: ".sidebar", start: ["a.channel-row.selected", ".channel-row.selected .voice-row-main", "a.dm-row.selected", "[aria-current=page]"] },
  { box: ".app-main", start: [".channel-chat .chat-textarea", ".chat-scroller"], not: ".member-list" },
  { box: ".member-list", start: [".member-row"] },
];

/** Row lists for the arrow keys: the rows are the main control of each entry, never the small buttons inside or beside it. */
const LISTS: { box: string; rows: string }[] = [
  { box: ".server-rail", rows: ".rail-tile" },
  { box: ".sidebar-scroller", rows: "a.channel-row, .voice-row-main, a.dm-row, .sidebar-nav a, button[aria-expanded]:not(.channel-action)" },
  { box: ".member-list", rows: ".member-row" },
];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el: Element) => el.getClientRects().length > 0;

function regionOf(el: Element | null, regions: Region[]): number {
  if (!el) return -1;
  // The member list sits inside the main column: test the innermost regions first.
  for (let i = regions.length - 1; i >= 0; i--) if (el.closest(regions[i]!.box)) return i;
  return -1;
}

function enter(region: Region): boolean {
  const box = document.querySelector(region.box);
  if (!box || !visible(box)) return false;
  const usable = (el: Element) => visible(el) && !(region.not && el.closest(region.not));
  const target = [...region.start, FOCUSABLE].map(sel => [...box.querySelectorAll<HTMLElement>(sel)].find(usable)).find(Boolean);
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/** F6 handler: moves focus to the next (dir 1) or previous (dir -1) region that is on screen. */
export function cycleRegion(dir: 1 | -1): boolean {
  const from = regionOf(document.activeElement, REGIONS);
  const n = REGIONS.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from < 0 ? (dir === 1 ? -1 : 0) : from) + dir * step) % n + n) % n;
    if (enter(REGIONS[i]!)) return true;
  }
  return false;
}

/** Up/Down/Home/End on a row of one of the lists. Returns true when it moved focus (the caller prevents the default). */
export function moveInList(e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target">): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Home" && e.key !== "End") return false;
  const el = e.target instanceof Element ? e.target : null;
  for (const list of LISTS) {
    const box = el?.closest(list.box);
    if (!box || !el!.matches(list.rows)) continue;
    const rows = [...box.querySelectorAll<HTMLElement>(list.rows)].filter(visible);
    const at = rows.indexOf(el as HTMLElement);
    const next = e.key === "Home" ? rows[0] : e.key === "End" ? rows.at(-1) : rows[at + (e.key === "ArrowUp" ? -1 : 1)];
    if (!next || next === el) return false;
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    return true;
  }
  return false;
}

let installed = false;

/** Installs the arrow-key listener once (capture phase is not needed: rows have no key handling of their own for these keys). */
export function installListKeys(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", e => {
    if (!e.defaultPrevented && moveInList(e)) e.preventDefault();
  });
}
