import type { Snowflake } from "./types";

const DISCORD_EPOCH = 1420070400000;

/** Compare two snowflakes numerically without BigInt (both are canonical decimal strings). */
export function compareIds(a: Snowflake, b: Snowflake): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxId(a: Snowflake | null | undefined, b: Snowflake | null | undefined): Snowflake | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareIds(a, b) >= 0 ? a : b;
}

/** Creation time (ms since the Unix epoch) encoded in a snowflake. */
export function snowflakeToTimestamp(id: Snowflake): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
}

/** Smallest snowflake for a timestamp: handy for date jumps and seeding. */
export function timestampToSnowflake(ms: number, increment = 0): Snowflake {
  return ((BigInt(Math.max(ms - DISCORD_EPOCH, 0)) << 22n) | BigInt(increment & 0xfff)).toString();
}
