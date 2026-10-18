import { describe, expect, it, vi } from "vitest";

vi.mock("../api/rest", () => ({ request: vi.fn(), resolveUrl: (url: string) => url }));
vi.mock("../api/gateway", () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

import { appStore } from "../api/store";
import type { User } from "../api/types";
import { userContextItems } from "./menus";

const user = (id: string, bot: boolean): User => ({ id, username: `u${id}`, bot }) as User;
const ids = (u: User) => userContextItems(u).map(i => ("id" in i ? i.id : ""));

describe("user menu", () => {
  it("offers Add Friend for a person but not for a bot, and Block stays", () => {
    appStore.setState({ me: user("1", false) });
    expect(ids(user("2", false))).toContain("add-friend");
    const bot = ids(user("3", true));
    expect(bot).not.toContain("add-friend");
    expect(bot).toContain("block");
  });
});
