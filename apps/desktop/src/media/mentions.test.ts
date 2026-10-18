import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, ((d: unknown) => void)[]>());
vi.mock("./shell", () => ({
  ApiRequestError: Error,
  appStore: { getState: () => ({ guildOrder: [] }) },
  chatToast: vi.fn(),
  request: vi.fn(),
  gateway: {
    on: (t: string, fn: (d: unknown) => void) => {
      handlers.set(t, [...(handlers.get(t) ?? []), fn]);
      return () => undefined;
    },
  },
}));

import type { Message } from "../api/types";
import { useMedia, wireMedia } from "./store";

const fire = (t: string, d: unknown): void => handlers.get(t)?.forEach(fn => fn(d));

describe("RECENT_MENTION_DELETE from another device", () => {
  it("drops the row from the open Mentions tab and ignores ids it doesn't show", () => {
    wireMedia();
    useMedia.setState({ mentions: [{ id: "1" }, { id: "2" }] as Message[] });
    fire("RECENT_MENTION_DELETE", { message_id: "1" });
    expect(useMedia.getState().mentions?.map(m => m.id)).toEqual(["2"]);
    fire("RECENT_MENTION_DELETE", { message_id: "9" });
    expect(useMedia.getState().mentions?.map(m => m.id)).toEqual(["2"]);
    useMedia.setState({ mentions: null });
    fire("RECENT_MENTION_DELETE", { message_id: "2" });
    expect(useMedia.getState().mentions).toBeNull();
  });
});
