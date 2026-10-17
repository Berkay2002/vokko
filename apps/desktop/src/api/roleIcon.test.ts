import { describe, expect, it, vi } from "vitest";
import type { Guild, Role } from "./types";

vi.mock("./gateway", () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

const { appStore, roleIcon } = await import("./store");

const role = (id: string, position: number, unicode_emoji: string | null): Role => ({ id, name: `r${id}`, color: 0, hoist: false, position, permissions: "0", mentionable: false, unicode_emoji });

describe("roleIcon", () => {
  it("is the highest of the member's roles that has an icon", () => {
    const roles = [role("1", 0, null), role("2", 1, "🛡️"), role("3", 3, "⭐"), role("4", 2, null), role("5", 5, "👑")];
    appStore.setState({ guilds: { g: { id: "g", roles } as unknown as Guild } });
    expect(roleIcon("g", { roles: ["2", "3", "4"] })?.unicode_emoji).toBe("⭐");
    expect(roleIcon("g", { roles: ["4"] })).toBeNull();
    expect(roleIcon(null, { roles: ["5"] })).toBeNull();
  });
});
