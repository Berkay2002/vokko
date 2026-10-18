// Folds a run of a blocked author's messages into one row. Pure, so the row rules are unit-tested (blockedFold.test.ts).
import type { Snowflake } from '../api/types';
import type { Row } from './messageState';
import { compareIds } from './util';

export interface Fold {
  /** Every message id of the run, hidden or not. */
  ids: Snowflake[];
  /** The viewer chose Show: the messages follow the fold bar. */
  open: boolean;
}

/** A row that starts a folded run carries `fold`: it is the "N blocked messages" row while closed, the bar above the messages while open. */
export type DisplayRow = Row & { fold?: Fold };

export interface Folded {
  rows: DisplayRow[];
  /** Message id → its run, for the runs that are still closed (the message is hidden or sits behind the fold row). */
  closed: Map<Snowflake, Fold>;
  /** How many rows older than `anchor` the closed runs removed: Virtuoso's firstItemIndex has to move with them. */
  hiddenBefore(anchor: Snowflake | null): number;
}

/**
 * A run is consecutive rows by blocked authors; a day divider or the NEW divider on a later row ends it, so neither is swallowed.
 * `revealed` holds the ids of runs the viewer opened; a run is open when any of its ids is in it (an older page can extend a run).
 */
export function foldBlocked(rows: Row[], isBlocked: (authorId: Snowflake) => boolean, revealed: ReadonlySet<Snowflake>): Folded {
  const out: DisplayRow[] = [];
  const closed = new Map<Snowflake, Fold>();
  const hidden: Snowflake[] = [];
  let run: Row[] = [];
  const flush = () => {
    if (!run.length) return;
    const ids = run.map(r => r.message.id);
    const fold: Fold = { ids, open: ids.some(id => revealed.has(id)) };
    out.push({ ...run[0]!, fold });
    if (fold.open) out.push(...run.slice(1));
    else {
      for (const id of ids) closed.set(id, fold);
      hidden.push(...ids.slice(1));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.pending || !isBlocked(row.message.author.id)) {
      flush();
      out.push(row);
      continue;
    }
    if (run.length && (row.dayLabel || row.unreadDivider)) flush();
    run.push(row);
  }
  flush();
  return { rows: out, closed, hiddenBefore: anchor => (anchor ? hidden.filter(id => compareIds(id, anchor) < 0).length : 0) };
}

/** "3 blocked messages" */
export const foldLabel = (count: number): string => `${count} blocked message${count === 1 ? '' : 's'}`;
