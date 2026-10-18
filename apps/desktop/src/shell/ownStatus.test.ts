import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ desktop: false, send: vi.fn() }));

vi.mock("../desktop", () => ({ isDesktop: () => mocks.desktop }));

import { setOwnActivities } from "../activity/own";
import { gateway } from "../api/gateway";
import { appStore, type AppState } from "../api/store";
import { GatewayOp } from "../api/types";
import { resendOwnStatus, setOwnStatus } from "./actions";

beforeEach(() => {
  mocks.send.mockReset();
  vi.spyOn(gateway, "send").mockImplementation(mocks.send);
  mocks.desktop = false;
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) });
});

afterEach(() => {
  setOwnActivities([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setOwnStatus (op 3)", () => {
  it("leaves `activities` out in the browser, so it cannot clear the game the desktop app reported", () => {
    setOwnStatus("idle", " brb ");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [op, body] = mocks.send.mock.calls[0] as [number, Record<string, unknown>];
    expect(op).toBe(GatewayOp.PresenceUpdate);
    expect(body).toEqual({ status: "idle", custom_status: "brb" });
    expect("activities" in body).toBe(false);
  });

  it("sends the detected activities from the desktop app, with every status change and resend", () => {
    mocks.desktop = true;
    setOwnActivities([{ name: "Factorio", type: 0, timestamps: { start: 5 } }]);
    setOwnStatus("dnd", "");
    resendOwnStatus();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    for (const [, body] of mocks.send.mock.calls) {
      expect(body).toEqual({ status: "dnd", custom_status: null, activities: [{ name: "Factorio", type: 0, timestamps: { start: 5 } }] });
    }
  });

  it("shows the new status and note on the user's own presence at once, keeping the reported activities", () => {
    const game = { name: "Factorio", type: 0 as const };
    appStore.setState({ me: { id: "1", username: "me" } as AppState["me"], presences: { "1": { user_id: "1", status: "online", custom_status: null, activities: [game] } } });
    setOwnStatus("invisible", " away ");
    expect(appStore.getState().presences["1"]).toEqual({ user_id: "1", status: "offline", custom_status: "away", activities: [game] });
  });

  it("sends an empty list from the desktop app when no game is detected (that is how a game is cleared)", () => {
    mocks.desktop = true;
    setOwnStatus("online", "");
    expect(mocks.send.mock.calls[0]?.[1]).toEqual({ status: "online", custom_status: null, activities: [] });
  });
});
