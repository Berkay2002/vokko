// Call stage grid: how many columns make the biggest 16:9 tiles for `count` participants in a `width` x `height` box.

export interface GridLayout {
  cols: number;
  rows: number;
  /** Tile size in px (0 when the box has no room). */
  tileWidth: number;
  tileHeight: number;
}

export const GRID_GAP = 8;

/** Tries every column count and keeps the one with the largest tile; on a tie, the fewer columns win. */
export function gridLayout(count: number, width: number, height: number, gap = GRID_GAP, aspect = 16 / 9): GridLayout {
  if (count <= 0) return { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0 };
  let best: GridLayout = { cols: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = (width - (cols - 1) * gap) / cols;
    const byHeight = ((height - (rows - 1) * gap) / rows) * aspect;
    const tileWidth = Math.max(0, Math.floor(Math.min(byWidth, byHeight)));
    if (tileWidth > best.tileWidth) best = { cols, rows, tileWidth, tileHeight: Math.floor(tileWidth / aspect) };
  }
  return best;
}
